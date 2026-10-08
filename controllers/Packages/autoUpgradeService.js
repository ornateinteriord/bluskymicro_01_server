const MemberModel = require("../../models/Users/Member");
const AddOnPackageModel = require("../../models/Packages/AddOnPackage");
const TransactionModel = require("../../models/Transaction/Transaction");
const ReceiptsModel = require("../../models/receipts.model");
const mlmService = require("../Users/mlmService/mlmService");

// const PACKAGE_SEQUENCE = [500, 1000, 2000, 3000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000];

const processAutoUpgrades = async () => {
  console.log("⏰ [CRON] Starting Auto Upgrade Wallet Process...");
  let processedCount = 0;

  try {
    // Fetch all active members who might have upgrade wallet balance
    const members = await MemberModel.find({
      status: "active",
      upgrade_wallet: { $gt: 0 }
    });

    for (const member of members) {
      // Find highest current package for this member
      let currentHighestPackage = 0;
      if (member.package_value && !isNaN(Number(member.package_value))) {
        currentHighestPackage = Number(member.package_value);
      }

      const addOnPackages = await AddOnPackageModel.find({ member_id: member.Member_id });
      for (const addon of addOnPackages) {
        if (addon.amount && !isNaN(Number(addon.amount))) {
          if (Number(addon.amount) > currentHighestPackage) {
            currentHighestPackage = Number(addon.amount);
          }
        }
      }

      // Determine next package in sequence
      let nextPackageAmount = null;
      for (const pkg of PACKAGE_SEQUENCE) {
        if (pkg > currentHighestPackage) {
          nextPackageAmount = pkg;
          break;
        }
      }

      // If there is no next package (they reached max), or upgrade wallet is less than next package, skip
      if (!nextPackageAmount || member.upgrade_wallet < nextPackageAmount) {
        continue;
      }

      // Process Upgrade
      console.log(`[Auto-Upgrade] Member ${member.Member_id} upgrading to ₹${nextPackageAmount}`);

      const requested_amount = nextPackageAmount;
      const finalTargetId = member.Member_id;
      const request_id = `AUTO_UPG_${Date.now()}`;

      // 1. Deduct from Upgrade Wallet
      await MemberModel.findOneAndUpdate(
        { Member_id: member.Member_id },
        { $inc: { upgrade_wallet: -requested_amount } }
      );

      // 2. Log Deduction Transaction
      const lastTx = await TransactionModel.findOne({}).sort({ createdAt: -1 }).exec();
      let newTxId = 1;
      if (lastTx && lastTx.transaction_id) {
        const lastIdNum = parseInt(lastTx.transaction_id.replace(/\D/g, ""), 10) || 0;
        newTxId = lastIdNum + 1;
      }

      const deductionTx = new TransactionModel({
        transaction_id: newTxId.toString(),
        transaction_date: new Date(),
        member_id: member.Member_id,
        Name: member.Name,
        mobileno: member.mobileno,
        description: `Auto Upgrade Package Purchase (₹${requested_amount})`,
        transaction_type: "Upgrade Wallet Deduction",
        ew_credit: 0,
        ew_debit: 0,
        uw_credit: 0,
        uw_debit: requested_amount,
        status: "Completed",
        net_amount: requested_amount,
        gross_amount: requested_amount
      });
      await deductionTx.save();

      // 3. Create Package (as Add-On)
      const newAddOn = new AddOnPackageModel({
        package_id: `PKG-A-${Date.now()}`,
        member_id: finalTargetId,
        amount: requested_amount,
        request_id: request_id,
        admin_id: "SYSTEM_AUTO"
      });
      await newAddOn.save();



      // 4. Single Leg Income Logic
      const singleLineIncomeAmount = Number((requested_amount * 0.002).toFixed(2));

      if (singleLineIncomeAmount > 0) {
        const fdAmount = Number((singleLineIncomeAmount * 0.50).toFixed(2));
        const withdrawalAmount = Number((singleLineIncomeAmount * 0.10).toFixed(2));
        const purchaseAmount = Number((singleLineIncomeAmount * 0.20).toFixed(2));
        const upgradeAmount = Number((singleLineIncomeAmount * 0.20).toFixed(2));

        try {
          let bundleAmounts = [requested_amount, requested_amount.toString()];

          const primaryBuyers = await MemberModel.find({
            package_value: { $in: bundleAmounts },
            Member_id: { $ne: finalTargetId }
          }).select('Member_id Name mobileno createdAt').lean();

          const addonBuyers = await AddOnPackageModel.find({
            amount: { $in: bundleAmounts },
            member_id: { $ne: finalTargetId }
          }).select('member_id createdAt').lean();

          const targetMemberTime = new Date(member.createdAt).getTime();
          const targetMemberId = member.Member_id;
          const eligibleMap = new Map();

          for (const buyer of primaryBuyers) {
            const buyerTime = new Date(buyer.createdAt).getTime();
            if ((buyerTime < targetMemberTime || (buyerTime === targetMemberTime && buyer.Member_id < targetMemberId)) && !eligibleMap.has(buyer.Member_id)) {
              eligibleMap.set(buyer.Member_id, { id: buyer.Member_id, name: buyer.Name, phone: buyer.mobileno, time: buyerTime });
            }
          }

          for (const addon of addonBuyers) {
            if (!eligibleMap.has(addon.member_id)) {
              const m = await MemberModel.findOne({ Member_id: addon.member_id }).select('Member_id Name mobileno createdAt').lean();
              if (m) {
                const mTime = new Date(m.createdAt).getTime();
                if (mTime < targetMemberTime || (mTime === targetMemberTime && m.Member_id < targetMemberId)) {
                  eligibleMap.set(addon.member_id, { id: m.Member_id, name: m.Name, phone: m.mobileno, time: mTime });
                }
              }
            }
          }

          let eligibleMembers = Array.from(eligibleMap.values());
          eligibleMembers.sort((a, b) => a.time - b.time);
          const finalEligibleMembers = eligibleMembers.slice(-100);

          for (const emember of finalEligibleMembers) {
            const sliTransaction = new TransactionModel({
              transaction_id: `SLI${Date.now()}${Math.floor(Math.random() * 1000)}`,
              transaction_date: new Date().toISOString(),
              member_id: emember.id,
              Name: emember.name,
              mobileno: emember.phone,
              description: `Single Leg Income (₹${requested_amount}) from ${finalTargetId} (Auto Upgrade)`,
              transaction_type: "Single Leg Income",
              fd_credit: fdAmount.toString(),
              ew_credit: withdrawalAmount.toString(),
              uw_credit: upgradeAmount.toString(),
              pw_credit: purchaseAmount.toString(),
              ew_debit: "0",
              status: "Completed",
              net_amount: singleLineIncomeAmount,
              gross_amount: singleLineIncomeAmount
            });

            await sliTransaction.save();

            await MemberModel.findOneAndUpdate(
              { Member_id: emember.id },
              { 
                $inc: { 
                  fixed_deposit_wallet: fdAmount,
                  wallet_balance: withdrawalAmount, 
                  upgrade_wallet: upgradeAmount,
                  purchase_wallet: purchaseAmount,
                  global_income: singleLineIncomeAmount
                } 
              }
            );
          }
        } catch (err) {
          console.error("Error distributing single leg income in auto upgrade:", err);
        }
      }

      // 5. MLM Commissions
      try {
        const commissions = await mlmService.calculateCommissions(
          finalTargetId,
          member.sponsor_id,
          requested_amount,
          "Add-On"
        );
        if (commissions.length > 0) {
          await mlmService.processCommissions(commissions);
        }
      } catch (commErr) {
        console.error(`⚠️ Commission distribution failed in auto upgrade:`, commErr.message);
      }

      // 6. Banking Receipt
      try {
        const lastReceipt = await ReceiptsModel.findOne().sort({ receipt_id: -1 }).limit(1);
        let newReceiptId = "RPT0001";
        if (lastReceipt && lastReceipt.receipt_id) {
          const numericPart = lastReceipt.receipt_id.replace(/^RPT/, '');
          const lastId = parseInt(numericPart);
          if (!isNaN(lastId)) {
            newReceiptId = `RPT${(lastId + 1).toString().padStart(4, '0')}`;
          }
        }

        await ReceiptsModel.create({
          receipt_id: newReceiptId,
          receipt_date: new Date(),
          received_from: member.Name,
          receipt_details: `Auto Upgrade Package Purchase - ${requested_amount}`,
          mode_of_payment_received: "Upgrade Wallet",
          amount: requested_amount,
          status: "active",
          ref_no: request_id,
          receipt_no: `REC-${Date.now()}`,
          entered_by: "SYSTEM_AUTO",
          branch_code: member.branch_id || "BRN001",
          member_id: member.Member_id
        });
      } catch (receiptErr) {
        console.error(`❌ Banking Receipt generation failed in auto upgrade:`, receiptErr.message);
      }

      processedCount++;
    }

    console.log(`✅ [CRON] Auto Upgrade Wallet Process completed. Processed: ${processedCount} upgrades.`);
    return { success: true, processedCount };
  } catch (error) {
    console.error("❌ [CRON] Error in Auto Upgrade Wallet Process:", error.message);
    return { success: false, error: error.message };
  }
};

module.exports = {
  processAutoUpgrades,
  PACKAGE_SEQUENCE
};
