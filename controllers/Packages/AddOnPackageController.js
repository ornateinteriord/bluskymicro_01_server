const AddOnRequestModel = require("../../models/Packages/AddOnRequest");
const AddOnPackageModel = require("../../models/Packages/AddOnPackage");
const MemberModel = require("../../models/Users/Member");
const AccountsModel = require("../../models/accounts.model");
const AccountGroupModel = require("../../models/accountGroup.model");
const mlmService = require("../Users/mlmService/mlmService");
const { processAddOnROI, processMemberROI } = require("../Users/roiService/roiService");
const PayoutModel = require("../../models/Payout/Payout");
const TransactionModel = require("../../models/Transaction/Transaction");
const moment = require("moment");
const ReceiptsModel = require("../../models/receipts.model");
const generateTransactionId = require("../../utils/generateTransactionId");
const { sendMail } = require("../../utils/EmailService");
const { generateTopUpApprovedEmail } = require("../../utils/generateMSCSEmail");// User requests a new addon package layer
const requestAddOn = async (req, res) => {
  try {
    const { member_id, requested_amount, tx_no, screenshot_url, payment_method } = req.body;

    if (!member_id || !requested_amount) {
      return res.status(400).json({ success: false, message: "Member ID and Amount are required" });
    }

    const member = await MemberModel.findOne({ Member_id: member_id });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const method = payment_method || "crypto";

    let generatedTxNo = tx_no;

    if (method === "wallet") {
      const transactions = await TransactionModel.find({ member_id });
      const nonLoanTransactions = transactions.filter(tx =>
        !tx.transaction_type?.toLowerCase().includes('loan') &&
        !tx.description?.toLowerCase().includes('loan')
      );
      const completedAndPendingTx = nonLoanTransactions.filter(tx =>
        tx.status === "Completed" || tx.status === "Pending" || tx.status === "Approved"
      );
      const availableBalance = completedAndPendingTx.reduce((acc, tx) =>
        acc + (parseFloat(tx.ew_credit) || 0) - (parseFloat(tx.ew_debit) || 0), 0
      );

      if (availableBalance < Number(requested_amount)) {
        return res.status(400).json({ success: false, message: "Insufficient wallet balance." });
      }

      await MemberModel.findOneAndUpdate(
        { Member_id: member_id },
        { $inc: { wallet_balance: -Number(requested_amount) } }
      );

      const lastTransaction = await TransactionModel.findOne({}).sort({ createdAt: -1 }).exec();
      let newTransactionId = 1;
      if (lastTransaction && lastTransaction.transaction_id) {
        const lastIdNumber = parseInt(lastTransaction.transaction_id.replace(/\D/g, ""), 10) || 0;
        newTransactionId = lastIdNumber + 1;
      }

      const newTransaction = new TransactionModel({
        transaction_id: newTransactionId.toString(),
        transaction_date: new Date(),
        member_id: member_id,
        Name: member.Name,
        mobileno: member.mobileno,
        description: "Package Purchase Deduction",
        transaction_type: "Package Purchase",
        ew_credit: 0,
        ew_debit: Number(requested_amount),
        status: "Completed",
        net_amount: Number(requested_amount),
        gross_amount: Number(requested_amount)
      });
      await newTransaction.save();
      generatedTxNo = newTransaction.transaction_id;
    }

    const request_id = `AOR${Date.now()}`;
    const newRequest = new AddOnRequestModel({
      request_id,
      member_id,
      requested_amount: Number(requested_amount),
      payment_method: method,
      tx_no: generatedTxNo,
      screenshot_url: method === "wallet" ? null : screenshot_url
    });

    await newRequest.save();

    res.status(201).json({ success: true, message: "Load Fund request submitted successfully", request: newRequest });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Admin gets list of ALL requests 
const getAllRequests = async (req, res) => {
  try {
    const requests = await AddOnRequestModel.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get all approved add-ons for a specific member (user dashboard)
const getMemberAddOns = async (req, res) => {
  try {
    const { member_id } = req.params;

    // 1. Fetch standard add-on packages
    const addons = await AddOnPackageModel.find({
      member_id
    }).sort({ createdAt: 1 });

    // 2. Fetch FD accounts from accounts_tbl
    // First get the group IDs for FD
    const fdGroups = await AccountGroupModel.find({
      account_group_name: { $regex: /FIXED DEPOSIT|FD/i }
    }).select('account_group_id');

    const fdGroupIds = fdGroups.map(g => g.account_group_id);

    const fdAccounts = await AccountsModel.find({
      member_id: member_id,
      $or: [
        { account_type: { $in: fdGroupIds } },
        { account_no: { $regex: /^FD/i } }
      ],
      status: { $ne: "closed" }
    });

    // 3. Map FD accounts to look like addons
    const mappedFDs = fdAccounts.map(acc => {
      // Calculate progress for FD if possible
      let progressCount = 0;
      if (acc.date_of_opening && acc.date_of_maturity) {
        const start = moment(acc.date_of_opening);
        const end = moment(acc.date_of_maturity);
        const now = moment();
        const totalDays = end.diff(start, 'days');
        const elapsedDays = now.diff(start, 'days');

        if (totalDays > 0) {
          // Map to 300 scale for frontend compatibility if needed, 
          // or we'll handle it in frontend
          progressCount = Math.max(0, Math.min(elapsedDays, totalDays));
          // If we want to use the frontend's /300 logic:
          // progressCount = (elapsedDays / totalDays) * 300;
        }
      }

      return {
        package_id: acc.account_no || acc.account_id,
        member_id: acc.member_id,
        amount: acc.account_amount,
        roi_status: acc.status === 'active' ? 'Active' : 'Pending',
        roi_payout_target: acc.net_amount || (acc.account_amount + (acc.interest_amount || 0)),
        roi_payout_count: progressCount,
        roi_start_date: acc.date_of_opening,
        isFD: true,
        interest_rate: acc.interest_rate,
        duration: acc.duration,
        date_of_maturity: acc.date_of_maturity,
        account_type_name: "Fixed Deposit"
      };
    });

    // Combine them
    const combinedAddOns = [...addons, ...mappedFDs];

    res.status(200).json({ success: true, addons: combinedAddOns });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Admin Approves/Rejects the request
const evaluateRequest = async (req, res) => {
  try {
    const { request_id } = req.params;
    const { status, admin_id } = req.body; // 'APPROVED' or 'REJECTED'

    if (!["APPROVED", "REJECTED"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const request = await AddOnRequestModel.findOne({ request_id });
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    if (request.status !== "PENDING") {
      return res.status(400).json({ success: false, message: "Request already evaluated" });
    }

    request.status = status;
    request.admin_audit = {
      admin_id: admin_id || "SYSTEM",
      timestamp: new Date()
    };

    if (status === "APPROVED") {
      const member = await MemberModel.findOne({ Member_id: request.member_id });
      if (!member) {
        return res.status(404).json({ success: false, message: "Member not found" });
      }

      try {
        const lastTx = await TransactionModel.findOne({}).sort({ createdAt: -1 }).exec();
        let topUpTxId = 1;
        if (lastTx && lastTx.transaction_id) {
          const lastIdNum = parseInt(lastTx.transaction_id.replace(/\D/g, ""), 10) || 0;
          topUpTxId = lastIdNum + 1;
        }
        const topUpTransaction = new TransactionModel({
          transaction_id: topUpTxId.toString(),
          transaction_date: new Date(),
          member_id: request.member_id,
          Name: member.Name,
          mobileno: member.mobileno,
          description: "Load Fund",
          transaction_type: "Top up",
          ew_credit: request.requested_amount,
          ew_debit: 0,
          status: "Completed",
          net_amount: request.requested_amount,
          gross_amount: request.requested_amount,
          reference_no: request.request_id
        });
        await topUpTransaction.save();

        // Increment the Top Up Wallet balance in the Member table
        await MemberModel.findOneAndUpdate(
          { Member_id: request.member_id },
          { $inc: { top_up_wallet: Number(request.requested_amount) } }
        );

        console.log(`✅ Top Up Wallet credited: ₹${request.requested_amount} for ${request.member_id}`);

        // Send Email Notification
        const memberEmail = member.Email || member.email;
        if (memberEmail) {
          const { htmlContent, subject } = generateTopUpApprovedEmail(member.Name, request.requested_amount);
          const attachments = [{
            filename: 'BMS.png',
            path: require('path').join(__dirname, '../../utils/BMS.png'),
            cid: 'bmslogo'
          }];
          await sendMail(memberEmail, subject, htmlContent, "Top Up Approved", attachments);
          console.log(`📧 Top Up approval email sent to ${memberEmail}`);
        }

      } catch (topUpErr) {
        console.error(`❌ Top Up transaction creation failed for ${request_id}:`, topUpErr.message);
      }
    } else if (status === "REJECTED") {
      if (request.payment_method === "wallet") {
        const member = await MemberModel.findOne({ Member_id: request.member_id });
        if (member) {
          await MemberModel.findOneAndUpdate(
            { Member_id: request.member_id },
            { $inc: { wallet_balance: Number(request.requested_amount) } }
          );

          const lastTransaction = await TransactionModel.findOne({}).sort({ createdAt: -1 }).exec();
          let newTransactionId = 1;
          if (lastTransaction && lastTransaction.transaction_id) {
            const lastIdNumber = parseInt(lastTransaction.transaction_id.replace(/\D/g, ""), 10) || 0;
            newTransactionId = lastIdNumber + 1;
          }

          const newTransaction = new TransactionModel({
            transaction_id: newTransactionId.toString(),
            transaction_date: new Date(),
            member_id: request.member_id,
            Name: member.Name,
            mobileno: member.mobileno,
            description: "Package Purchase Refund (Rejected)",
            transaction_type: "Refund",
            ew_credit: Number(request.requested_amount),
            ew_debit: 0,
            status: "Completed",
            net_amount: Number(request.requested_amount),
            gross_amount: Number(request.requested_amount)
          });
          await newTransaction.save();
        }
      }
    }

    await request.save();

    res.status(200).json({ success: true, message: `Request successfully ${status.toLowerCase()}`, request });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getMemberRequests = async (req, res) => {
  try {
    const { member_id } = req.params;
    const requests = await AddOnRequestModel.find({ member_id }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// User instantly buys a package using Top Up Wallet
const buyPackageDirectly = async (req, res) => {
  try {
    const { member_id, requested_amount, target_member_id } = req.body;

    if (!member_id || !requested_amount) {
      return res.status(400).json({ success: false, message: "Member ID and Amount are required" });
    }

    const finalTargetId = target_member_id || member_id;

    const payer = await MemberModel.findOne({ Member_id: member_id });
    if (!payer) {
      return res.status(404).json({ success: false, message: "Payer member not found" });
    }

    const targetMember = await MemberModel.findOne({ Member_id: finalTargetId });
    if (!targetMember) {
      return res.status(404).json({ success: false, message: "Target member not found" });
    }

    // 0. Check if package already purchased
    if (Number(targetMember.package_value) === Number(requested_amount)) {
      return res.status(400).json({ success: false, message: "You have already purchased this package." });
    }

    const existingAddOn = await AddOnPackageModel.findOne({ member_id: finalTargetId, amount: Number(requested_amount) });
    if (existingAddOn) {
      return res.status(400).json({ success: false, message: "You have already purchased this package." });
    }

    // 1. Verify Top Up Balance for Payer
    const transactions = await TransactionModel.find({ member_id: member_id });
    const topUpTransactions = transactions.filter(tx => tx.transaction_type === 'Top up');

    const topUpCredits = topUpTransactions
      .filter(tx => tx.status === 'Completed' || tx.status === 'Approved')
      .reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0), 0);
    const topUpDebits = topUpTransactions
      .filter(tx => tx.status === 'Completed' || tx.status === 'Approved')
      .reduce((acc, tx) => acc + (parseFloat(tx.ew_debit) || 0), 0);

    const topUpBalance = Math.max(0, topUpCredits - topUpDebits);

    if (topUpBalance < Number(requested_amount)) {
      return res.status(400).json({ success: false, message: "Insufficient Top Up Balance." });
    }

    // 2. Deduct from Top Up Balance (Payer)
    const lastTx = await TransactionModel.findOne({}).sort({ createdAt: -1 }).exec();
    let newTxId = 1;
    if (lastTx && lastTx.transaction_id) {
      const lastIdNum = parseInt(lastTx.transaction_id.replace(/\D/g, ""), 10) || 0;
      newTxId = lastIdNum + 1;
    }

    let description = "Direct Package Purchase";
    if (member_id !== finalTargetId) {
      description = `Package Purchase for ${finalTargetId}`;
    }

    const deductionTx = new TransactionModel({
      transaction_id: newTxId.toString(),
      transaction_date: new Date(),
      member_id: member_id,
      Name: payer.Name,
      mobileno: payer.mobileno,
      description: description,
      transaction_type: "Top up", // Crucial: must be 'Top up' to affect topUpBalance correctly
      ew_credit: 0,
      ew_debit: Number(requested_amount),
      status: "Completed",
      net_amount: Number(requested_amount),
      gross_amount: Number(requested_amount),
      balance: (topUpBalance - Number(requested_amount)).toString()
    });
    await deductionTx.save();

    // Deduct the Top Up Wallet balance in the Member table
    await MemberModel.findOneAndUpdate(
      { Member_id: member_id },
      { $inc: { top_up_wallet: -Number(requested_amount) } }
    );

    // 3. Create Package & Single Leg Income Logic for Target Member
    const request_id = `DIR${Date.now()}`; // Pseudo request ID for tracking

    // CASE A: Primary Package
    if (!targetMember.package_value || targetMember.package_value === 0) {
      targetMember.package_value = requested_amount;
      targetMember.spackage = `PKG-${requested_amount}`;
      targetMember.status = "active";
      await targetMember.save();
    }
    // CASE B: Add-On Package
    else {
      const newAddOn = new AddOnPackageModel({
        package_id: `PKG-A-${Date.now()}`,
        member_id: finalTargetId,
        amount: requested_amount,
        request_id: request_id,
        admin_id: "SYSTEM_DIRECT"
      });
      await newAddOn.save();
    }

    // try {
    //   const { distributeGlobalIncome } = require("./globalIncomeService");
    //   await distributeGlobalIncome(finalTargetId, requested_amount);
    // } catch (globalIncomeErr) {
    //   console.error("Global income distribution failed:", globalIncomeErr);
    // }

    // --- NEW: Single Leg Income (1% cashback to the user themselves + up to 100 previous buyers of the same package) ---
    // Calculate bundle amounts based on the requested amount
    let bundleAmounts = [requested_amount, requested_amount.toString()];

    if (bundleAmounts.length > 0) {
      try {
        const primaryBuyers = await MemberModel.find({

          package_value: { $in: bundleAmounts },
          Member_id: { $ne: finalTargetId }
        }).select('Member_id Name mobileno createdAt package_value').lean();

        const addonBuyers = await AddOnPackageModel.find({
          amount: { $in: bundleAmounts },
          member_id: { $ne: finalTargetId }
        }).select('member_id amount createdAt').lean();

        console.log(`=== SINGLE LEG INCOME DISTRIBUTION START ===`);
        console.log(`Buyer: ${finalTargetId}, Package Amount: ₹${requested_amount}`);

        const targetMemberTime = new Date(targetMember.createdAt).getTime();
        const targetMemberId = targetMember.Member_id;
        const eligibleMap = new Map(); // Use map to keep only unique members

        for (const buyer of primaryBuyers) {
          const buyerTime = new Date(buyer.createdAt).getTime();
          if ((buyerTime < targetMemberTime || (buyerTime === targetMemberTime && buyer.Member_id < targetMemberId)) && !eligibleMap.has(buyer.Member_id)) {
            eligibleMap.set(buyer.Member_id, { id: buyer.Member_id, name: buyer.Name, phone: buyer.mobileno, time: buyerTime, package_amount: Number(buyer.package_value) });
          }
        }

        for (const addon of addonBuyers) {
          if (!eligibleMap.has(addon.member_id)) {
            const m = await MemberModel.findOne({ Member_id: addon.member_id }).select('Member_id Name mobileno createdAt').lean();
            if (m) {
              const mTime = new Date(m.createdAt).getTime();
              if (mTime < targetMemberTime || (mTime === targetMemberTime && m.Member_id < targetMemberId)) {
                eligibleMap.set(addon.member_id, { id: m.Member_id, name: m.Name, phone: m.mobileno, time: mTime, package_amount: Number(addon.amount) });
              }
            }
          }
        }

        // Sort by time (oldest to newest) to find the chronological line, and take the 100 most recent ones before this user
        let eligibleMembers = Array.from(eligibleMap.values());
        eligibleMembers.sort((a, b) => a.time - b.time);
        const finalEligibleMembers = eligibleMembers.slice(-100);

        console.log(`Total Eligible Upline Users Found: ${finalEligibleMembers.length}`);
        console.log(`Eligible Users List:`, finalEligibleMembers.map(m => m.id));
        console.log(`============================================`);

        for (const member of finalEligibleMembers) {
          // Each upliner gets 1% of the NEW buyer's package amount, all to FD Wallet
          const memberSingleLegIncome = Number((requested_amount * 0.01).toFixed(2));
          if (memberSingleLegIncome > 0) {
            const fdAmount = memberSingleLegIncome;
            
            const sliTransaction = new TransactionModel({
              transaction_id: `SLI${Date.now()}${Math.floor(Math.random() * 1000)}`,
              transaction_date: new Date().toISOString(),
              member_id: member.id,
              Name: member.name,
              mobileno: member.phone,
              description: `Single Leg Income (₹${member.package_amount}) from ${finalTargetId}'s bundle purchase`,
              transaction_type: "Single Leg Income",
              fd_credit: fdAmount.toString(),
              ew_credit: "0",
              uw_credit: "0",
              ew_debit: "0",
              status: "Completed",
              net_amount: memberSingleLegIncome,
              gross_amount: memberSingleLegIncome
            });

            await sliTransaction.save();

            await MemberModel.findOneAndUpdate(
              { Member_id: member.id },
              { $inc: { fixed_deposit_wallet: fdAmount } }
            );
          }
        }
      } catch (err) {
        console.error("Error distributing single leg income to previous buyers:", err);
      }
    }
    // ----------------------------------------------------------------------



    // 4. MLM Commissions - For Target Member's Sponsor
    try {
      const commissions = await mlmService.calculateCommissions(
        finalTargetId,
        targetMember.sponsor_id,
        requested_amount,
        "Add-On"
      );
      if (commissions.length > 0) {
        await mlmService.processCommissions(commissions);
      }
    } catch (commErr) {
      console.error(`⚠️ Commission distribution failed:`, commErr.message);
    }

    // 5. Banking Receipt
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
        received_from: payer.Name,
        receipt_details: `Direct Package Purchase ${member_id !== finalTargetId ? 'for ' + finalTargetId : ''} - ${requested_amount}`,
        mode_of_payment_received: "Top Up Wallet",
        amount: requested_amount,
        status: "active",
        ref_no: request_id,
        receipt_no: `REC-${Date.now()}`,
        entered_by: "SYSTEM_DIRECT",
        branch_code: payer.branch_id || "BRN001",
        member_id: member_id
      });
    } catch (receiptErr) {
      console.error(`❌ Banking Receipt generation failed:`, receiptErr.message);
    }

    res.status(200).json({ success: true, message: `Package purchased successfully!` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  requestAddOn,
  getAllRequests,
  getMemberAddOns,
  evaluateRequest,
  getMemberRequests,
  buyPackageDirectly
};

