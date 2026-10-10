const MemberModel = require("../../../models/Users/Member");
const AddOnPackageModel = require("../../../models/Packages/AddOnPackage");
const TransactionModel = require("../../../models/Transaction/Transaction");
const moment = require("moment");

// Lock management for global ROI processing
let isROIProcessing = false;
let lastGlobalProcessTime = 0;
const GLOBAL_LOCK_TIMEOUT = 10 * 60 * 1000; // 10 minutes

/**
 * Process daily ROI / Daily Incentive for all eligible members (Primary & Add-on packages).
 * Payout rules:
 * - 1% daily of the package/invested amount (e.g., ₹3 daily for ₹300)
 * - Duration: 200 days (target: 200 payouts)
 * - 50% credited to Credits Wallet (ew_credit / wallet_balance)
 * - 50% credited to Re-Top Up Wallet (tw_credit / top_up_wallet)
 * 
 * @param {string|null} targetMemberId - Optional member ID to process specifically
 * @param {string|null} customToday - Optional custom date override (YYYY-MM-DD)
 */
const processDailyROI = async (targetMemberId = null, customToday = null) => {
    const now = Date.now();
    if (isROIProcessing && (now - lastGlobalProcessTime < GLOBAL_LOCK_TIMEOUT)) {
        console.log("⚠️ ROI processing is already running. Skipping concurrent run.");
        return { success: false, message: "ROI processing already in progress" };
    }

    isROIProcessing = true;
    lastGlobalProcessTime = now;

    const todayStr = customToday || moment().utcOffset("+05:30").format("YYYY-MM-DD");
    let processedCount = 0;
    let baseProcessedCount = 0;
    let addonProcessedCount = 0;

    try {
        console.log(`⏰ [Daily Incentive] Starting Daily Incentive distribution for date: ${todayStr}...`);

        // ─────────────────────────────────────────────────────────────
        // 1. PROCESS PRIMARY PACKAGES (Stored directly in MemberModel)
        // ─────────────────────────────────────────────────────────────
        const memberQuery = {
            package_value: { $gt: 0 },
            status: "active",
            roi_status: { $ne: "Completed" }
        };

        if (targetMemberId) {
            memberQuery.Member_id = targetMemberId;
        }

        const activeMembers = await MemberModel.find(memberQuery);
        console.log(`🔍 [Daily Incentive] Found ${activeMembers.length} active members with primary packages.`);

        for (const member of activeMembers) {
            try {
                const pkgAmount = Number(member.package_value) || 0;
                if (pkgAmount <= 0) continue;

                const targetDays = member.roi_payout_target || 200;
                let currentCount = member.roi_payout_count || 0;

                if (currentCount >= targetDays) {
                    await MemberModel.updateOne(
                        { Member_id: member.Member_id },
                        { $set: { roi_status: "Completed" } }
                    );
                    continue;
                }

                // Determine start date
                const startDateStr = member.roi_start_date || member.Date_of_joining || todayStr;
                const lastPayoutDateStr = member.roi_last_payout_date || null;

                // Calculate eligible dates to process (Catch-up logic)
                let dateCursor;
                if (!lastPayoutDateStr) {
                    dateCursor = moment(startDateStr, "YYYY-MM-DD");
                } else {
                    dateCursor = moment(lastPayoutDateStr, "YYYY-MM-DD").add(1, "days");
                }

                const todayMoment = moment(todayStr, "YYYY-MM-DD");
                const daysToProcess = [];

                while (dateCursor.isSameOrBefore(todayMoment) && (currentCount + daysToProcess.length) < targetDays) {
                    daysToProcess.push(dateCursor.format("YYYY-MM-DD"));
                    dateCursor.add(1, "days");
                }

                if (daysToProcess.length === 0) {
                    continue;
                }

                // 1% daily payout - 100% to Credits Wallet
                const dailyTotalAmount = Math.round(pkgAmount * 0.01 * 100) / 100; // e.g. 3.00 for 300
                const creditAmount = dailyTotalAmount;

                for (const payoutDate of daysToProcess) {
                    const newCount = currentCount + 1;
                    const txId = `DI_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

                    // Create transaction with 100% Credits (ew_credit)
                    const dailyTx = new TransactionModel({
                        transaction_id: txId,
                        transaction_date: payoutDate,
                        member_id: member.Member_id,
                        Name: member.Name,
                        mobileno: member.mobileno,
                        description: `Daily Incentive (1% of ₹${pkgAmount}) - Day ${newCount}/${targetDays}`,
                        transaction_type: "Daily Incentive",
                        ew_credit: creditAmount.toString(),
                        tw_credit: "0",
                        ew_debit: "0",
                        tw_debit: "0",
                        gross_amount: dailyTotalAmount.toString(),
                        net_amount: dailyTotalAmount.toString(),
                        status: "Completed",
                        benefit_type: "Daily Incentive",
                        reference_no: `DI-P-${member.Member_id}-${newCount}`
                    });

                    await dailyTx.save();

                    currentCount = newCount;
                    baseProcessedCount++;
                    processedCount++;

                    // Update Member wallet balance and ROI status
                    const isNowCompleted = currentCount >= targetDays;
                    await MemberModel.updateOne(
                        { Member_id: member.Member_id },
                        {
                            $inc: {
                                wallet_balance: creditAmount
                            },
                            $set: {
                                roi_payout_count: currentCount,
                                roi_last_payout_date: payoutDate,
                                roi_status: isNowCompleted ? "Completed" : "Active"
                            }
                        }
                    );

                    console.log(`✅ [Daily Incentive] Credited Day ${newCount}/${targetDays} to ${member.Member_id}: Total ₹${dailyTotalAmount} Credits`);
                }

            } catch (memberErr) {
                console.error(`❌ [Daily Incentive] Error processing primary ROI for member ${member.Member_id}:`, memberErr.message);
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 2. PROCESS ADD-ON PACKAGES (Stored in AddOnPackageModel)
        // ─────────────────────────────────────────────────────────────
        const addonQuery = {
            amount: { $gt: 0 },
            roi_status: { $ne: "Completed" }
        };

        if (targetMemberId) {
            addonQuery.member_id = targetMemberId;
        }

        const activeAddons = await AddOnPackageModel.find(addonQuery);
        console.log(`🔍 [Daily Incentive] Found ${activeAddons.length} active add-on packages.`);

        for (const addon of activeAddons) {
            try {
                const pkgAmount = Number(addon.amount) || 0;
                if (pkgAmount <= 0) continue;

                const targetDays = addon.roi_payout_target || 200;
                let currentCount = addon.roi_payout_count || 0;

                if (currentCount >= targetDays) {
                    await AddOnPackageModel.updateOne(
                        { _id: addon._id },
                        { $set: { roi_status: "Completed" } }
                    );
                    continue;
                }

                const member = await MemberModel.findOne({ Member_id: addon.member_id });
                if (!member) continue;

                const startDateStr = addon.roi_start_date || todayStr;
                const lastPayoutDateStr = addon.roi_last_payout_date || null;

                let dateCursor;
                if (!lastPayoutDateStr) {
                    dateCursor = moment(startDateStr, "YYYY-MM-DD");
                } else {
                    dateCursor = moment(lastPayoutDateStr, "YYYY-MM-DD").add(1, "days");
                }

                const todayMoment = moment(todayStr, "YYYY-MM-DD");
                const daysToProcess = [];

                while (dateCursor.isSameOrBefore(todayMoment) && (currentCount + daysToProcess.length) < targetDays) {
                    daysToProcess.push(dateCursor.format("YYYY-MM-DD"));
                    dateCursor.add(1, "days");
                }

                if (daysToProcess.length === 0) {
                    continue;
                }

                const dailyTotalAmount = Math.round(pkgAmount * 0.01 * 100) / 100;
                const creditAmount = dailyTotalAmount;

                for (const payoutDate of daysToProcess) {
                    const newCount = currentCount + 1;
                    const txId = `DI_A_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

                    const dailyTx = new TransactionModel({
                        transaction_id: txId,
                        transaction_date: payoutDate,
                        member_id: addon.member_id,
                        Name: member.Name,
                        mobileno: member.mobileno,
                        description: `Daily Incentive (1% of ₹${pkgAmount} Add-on) - Day ${newCount}/${targetDays}`,
                        transaction_type: "Daily Incentive",
                        ew_credit: creditAmount.toString(),
                        tw_credit: "0",
                        ew_debit: "0",
                        tw_debit: "0",
                        gross_amount: dailyTotalAmount.toString(),
                        net_amount: dailyTotalAmount.toString(),
                        status: "Completed",
                        benefit_type: "Daily Incentive",
                        reference_no: `DI-A-${addon.package_id}-${newCount}`
                    });

                    await dailyTx.save();

                    currentCount = newCount;
                    addonProcessedCount++;
                    processedCount++;

                    const isNowCompleted = currentCount >= targetDays;

                    // Update AddOn Package record
                    await AddOnPackageModel.updateOne(
                        { _id: addon._id },
                        {
                            $set: {
                                roi_payout_count: currentCount,
                                roi_last_payout_date: payoutDate,
                                roi_status: isNowCompleted ? "Completed" : "Active"
                            }
                        }
                    );

                    // Credit Member wallet
                    await MemberModel.updateOne(
                        { Member_id: addon.member_id },
                        {
                            $inc: {
                                wallet_balance: creditAmount
                            }
                        }
                    );

                    console.log(`✅ [Daily Incentive] Credited Addon Day ${newCount}/${targetDays} to ${addon.member_id}: Total ₹${dailyTotalAmount} Credits`);
                }

            } catch (addonErr) {
                console.error(`❌ [Daily Incentive] Error processing addon ROI for ${addon.package_id}:`, addonErr.message);
            }
        }

        console.log(`🎉 [Daily Incentive] Completed processing: ${processedCount} payouts (${baseProcessedCount} primary, ${addonProcessedCount} addon).`);

        return {
            success: true,
            baseProcessedCount,
            addonProcessedCount,
            processedCount,
            message: `Processed ${processedCount} Daily Incentive payouts successfully.`
        };

    } catch (globalErr) {
        console.error("❌ [Daily Incentive] Global ROI processing error:", globalErr.message);
        return { success: false, error: globalErr.message };
    } finally {
        isROIProcessing = false;
    }
};

/**
 * Process ROI for a single member on demand
 */
const processMemberROI = async (member) => {
    return processDailyROI(member.Member_id);
};

/**
 * Process ROI for a single Add-On package on demand
 */
const processAddOnROI = async (addon, member) => {
    return processDailyROI(member?.Member_id || addon.member_id);
};

module.exports = { processDailyROI, processMemberROI, processAddOnROI };
