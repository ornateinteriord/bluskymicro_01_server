const PayoutModel = require("../../../models/Payout/Payout");
const TransactionModel = require("../../../models/Transaction/Transaction");
const MemberModel = require("../../../models/Users/Member");
const {
  updateSponsorReferrals,
  calculateCommissions,
  processCommissions,
  getOrdinal,
  commissionRates,
  getUplineTree
} = require("../mlmService/mlmService");
const { processDailyROI } = require("../roiService/roiService");

// Reusable function to update referral hierarchy when a member becomes active
const updateReferralHierarchy = async (newMemberId, sponsorId) => {
  try {
    const newMember = await MemberModel.findOne({ Member_id: newMemberId });
    if (!newMember) throw new Error(`Member not found: ${newMemberId}`);
    if (newMember.status !== "active") throw new Error(`Member status must be active, current status: ${newMember.status}`);

    const sponsor = await MemberModel.findOne({ Member_id: sponsorId });
    if (!sponsor) throw new Error(`Sponsor not found with ID: ${sponsorId}`);

    if (newMember.sponsor_id !== sponsor.Member_id) {
      await MemberModel.findOneAndUpdate(
        { Member_id: newMemberId },
        { sponsor_id: sponsor.Member_id, Sponsor_code: sponsor.Member_id, Sponsor_name: sponsor.Name }
      );
    }

    await updateSponsorReferrals(sponsor.Member_id, newMemberId);

    return { success: true, new_member: { id: newMemberId }, sponsor: { id: sponsor.Member_id } };
  } catch (error) {
    console.error("❌ Error updating referral hierarchy:", error.message || error);
    throw error;
  }
};

const triggerMLMCommissions = async (req, res) => {
  try {
    const { new_member_id, Sponsor_code } = req.body;

    console.log("🟢 Incoming Request Data (Referral Update Only):", { new_member_id, Sponsor_code });

    if (!new_member_id || !Sponsor_code) {
      return res.status(400).json({
        success: false,
        message: "Member ID and Sponsor code are required"
      });
    }

    // Find new member
    const newMember = await MemberModel.findOne({ Member_id: new_member_id });
    // console.log("📘 Found New Member:", newMember);

    if (!newMember) {
      return res.status(404).json({
        success: false,
        message: `Member not found: ${new_member_id}`
      });
    }

    if (newMember.status !== "active") {
      return res.status(400).json({
        success: false,
        message: `Member status must be active, current status: ${newMember.status}`
      });
    }

    // Find sponsor using Member_id instead of member_code
    const sponsor = await MemberModel.findOne({ Member_id: Sponsor_code });
    console.log("📗 Found Sponsor:", sponsor);

    if (!sponsor) {
      return res.status(404).json({
        success: false,
        message: `Sponsor not found with ID: ${Sponsor_code}`
      });
    }

    // Update member's sponsor details if needed
    if (newMember.sponsor_id !== sponsor.Member_id) {
      await MemberModel.findOneAndUpdate(
        { Member_id: new_member_id },
        {
          sponsor_id: sponsor.Member_id,
          Sponsor_code: sponsor.Member_id,
          Sponsor_name: sponsor.Name
        }
      );
      console.log("🔄 Updated sponsor details for new member:", new_member_id);
    }

    // Update direct sponsor's referrals list
    // THIS IS THE CRITICAL PART FOR HIERARCHY - ONLY THIS RUNS
    await updateSponsorReferrals(sponsor.Member_id, new_member_id);
    console.log("👥 Direct sponsor referrals updated");

    // Calculate and process multi-level commissions (10 levels based on percentage)
    const commissions = await calculateCommissions(new_member_id, sponsor.Member_id);
    let commissionResults = [];
    if (commissions.length > 0) {
      commissionResults = await processCommissions(commissions);
      console.log(`💰 Processed ${commissionResults.length} commissions for new member ${new_member_id}`);
    } else {
      console.log(`⚠️ No commissions generated for new member ${new_member_id}`);
    }

    return res.status(200).json({
      success: true,
      message: "Referral hierarchy and commissions updated successfully",
      data: {
        new_member: { id: new_member_id },
        sponsor: { id: sponsor.Member_id },
        commissions_generated: commissions.length,
        commissions_processed: commissionResults.filter(r => r.success).length
      }
    });

  } catch (error) {
    console.error("❌ Error triggering MLM commissions:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};


const getMemberCommissionSummary = async (req, res) => {
  try {
    return res.json({
      success: true,
      data: {
        member_id: req.params.member_id,
        message: "Commission system is disabled",
        total_earnings: 0,
        level_breakdown: {},
        level_payouts: {},
        upline_tree: [],
        commission_rates: {},
        recent_payouts: [],
        recent_level_benefits: []
      }
    });
    /*
    const { member_id } = req.params;

    // Get all payouts and transactions for the member
    const payouts = await PayoutModel.find({ memberId: member_id });
    const transactions = await TransactionModel.find({ member_id: member_id });

    // Calculate level earnings from payouts
    const levelEarnings = {};
    for (let level = 1; level <= 10; level++) {
      const levelPayouts = payouts.filter((p) => p.level === level);
      const levelAmount = levelPayouts.reduce((sum, p) => sum + p.amount, 0);

      levelEarnings[`level_${level}`] = {
        count: levelPayouts.length,
        amount: levelAmount,
        type: `${getOrdinal(level)} Level Benefits`,
        rate: commissionRates[level] || 0,
      };
    }

    // ✅ Get ALL level benefits from transactions (not just total)
    const levelBenefitsFromTx = {};
    let totalLevelBenefits = 0;

    for (let level = 1; level <= 10; level++) {
      const levelTransactions = transactions.filter(
        (tx) => tx.transaction_type === "Level Benefits" && tx.level === level
      );

      const levelAmount = levelTransactions.reduce(
        (sum, tx) => sum + (tx.ew_credit || 0),
        0
      );
      totalLevelBenefits += levelAmount;

      levelBenefitsFromTx[`level_${level}`] = {
        count: levelTransactions.length,
        amount: levelAmount,
        type: `${getOrdinal(level)} Level Benefits`,
        rate: commissionRates[level] || 0,
        transactions: levelTransactions.slice(0, 5), // Recent 5 transactions for this level
      };
    }

    // ✅ Get member data from Transaction table
    const memberTransaction = await TransactionModel.findOne({
      member_id: member_id,
    });

    // ✅ Get upline tree with active status information
    const uplineTree = await getUplineTree(member_id, 10);

    return res.json({
      success: true,
      data: {
        member_id,
        member_name: memberTransaction?.Name || memberTransaction?.member_name,
        member_code: memberTransaction?.member_code,
        mobile: memberTransaction?.mobileno || memberTransaction?.mobile,
        email: memberTransaction?.email,
        sponsor_code: memberTransaction?.Sponsor_code,
        sponsor_name: memberTransaction?.Sponsor_name,
        direct_referrals: memberTransaction?.direct_referrals?.length || 0,
        total_team: memberTransaction?.total_team || 0,
        total_earnings: totalLevelBenefits,
        level_breakdown: levelBenefitsFromTx, // Using transaction-based data
        level_payouts: levelEarnings, // Payout-based data for comparison
        upline_tree: uplineTree,
        commission_rates: commissionRates,
        recent_payouts: payouts.slice(0, 10).map((p) => ({
          date: p.date,
          type: p.payout_type,
          amount: p.amount,
          level: p.level,
          from_member: p.sponsored_member_id,
          status: p.status,
        })),
        // ✅ Additional: Recent level benefit transactions
        recent_level_benefits: transactions
          .filter((tx) => tx.transaction_type === "Level Benefits")
          .slice(0, 10)
          .map((tx) => ({
            date: tx.date,
            amount: tx.ew_credit,
            level: tx.level,
            from_member: tx.from_member_id,
            description: tx.description,
          })),
      },
    });
    */
  } catch (error) {
    console.error("Error getting commission summary:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

const getDailyPayout = async (req, res) => {
  try {
    const userRole = req.user.role;
    const { member_id } = req.params;

    let query = {};

    if (member_id) {
      const numericPart = parseInt(member_id.replace('BMS', ''), 10);
      const pad5 = String(numericPart).padStart(5, '0');
      const pad6 = String(numericPart).padStart(6, '0');
      const possibleIds = [member_id, member_id.replace('BMS', ''), `BMS${pad5}`, `BMS${pad6}`, pad5, pad6, `BMS${numericPart}`];
      
      if (userRole === "ADMIN") {
        query = { member_id: { $in: possibleIds } };
      } else if (userRole === "USER") {
        query = { member_id: { $in: possibleIds } };
      }
    }

    // Filter strictly for Single Level Income payouts as requested
    const transactions = await TransactionModel.find({
      ...query,
      transaction_type: { $in: ["Single Level Income", "Single Leg Income", "Single Line Income"] },
    }).sort({ transaction_date: -1 }); // Show latest first

    return res.status(200).json({
      success: true,
      data: { daily_earnings: transactions },
    });


  } catch (error) {
    console.error("Error in getDailyPayout:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const LOAN_TIERS = [];

const climeRewardLoan = async (req, res) => {
  return res.status(403).json({ success: false, message: "Reward loans are disabled." });
};

const getRewardLoansByStatus = async (req, res) => {
  return res.status(200).json({ success: true, data: { loans: [], totalCount: 0 } });
};

const processRewardLoan = async (req, res) => {
  return res.status(403).json({ success: false, message: "Reward loans are disabled." });
};

const repaymentLoan = async (req, res) => {
  return res.status(403).json({ success: false, message: "Reward loans are disabled." });
};

const triggerDailyROI = async (req, res) => {
  try {
    const result = await processDailyROI();
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error processing ROI",
      error: error.message
    });
  }
};

const getROIBenefits = async (req, res) => {
  try {
    const userRole = req.user.role;
    const { member_id } = req.params;

    let query = {};

    if (userRole === "ADMIN") {
      query = member_id ? { member_id } : {};
    } else if (userRole === "USER") {
      query = { member_id: member_id };
    }

    // Filter strictly for ROI Level Benefits with related member name population
    const transactions = await TransactionModel.aggregate([
      { 
        $match: {
          ...query,
    transaction_type: "ROI Level Benefit",
        }
      },
{
        $lookup: {
    from: "member_tbl",
      localField: "related_member_id",
        foreignField: "Member_id",
          as: "related_member"
  }
},
{
        $addFields: {
    related_member_name: {
            $ifNull: [
        "$related_member_name",
        { $arrayElemAt: ["$related_member.Name", 0] }
      ]
    }
  }
},
{
        $project: {
    related_member: 0
  }
},
{ $sort: { transaction_date: -1, createdAt: -1 } }
    ]);

return res.status(200).json({
  success: true,
  data: { roi_benefits: transactions },
});
  } catch (error) {
  console.error("Error in getROIBenefits:", error);
  return res.status(500).json({
    success: false,
    message: "Server error",
    error: error.message,
  });
}
};

const getROISummary = async (req, res) => {
  try {
    const todayStr = new Date().toISOString().split('T')[0];

    // 1. Total ROI Distributed
    const totalROIResult = await TransactionModel.aggregate([
      { $match: { transaction_type: "ROI Payout", status: "Completed" } },
      { $group: { _id: null, total: { $sum: { $toDouble: "$ew_credit" } } } }
    ]);
    const totalROIDistributed = totalROIResult[0]?.total || 0;

    // 2. Today's Payouts
    const todaysPayoutsResult = await TransactionModel.aggregate([
      { 
        $match: {
  transaction_type: "ROI Payout",
    status: "Completed",
      transaction_date: todayStr
} 
      },
{ $group: { _id: null, total: { $sum: { $toDouble: "$ew_credit" } }, count: { $sum: 1 } } }
    ]);
const todaysTotal = todaysPayoutsResult[0]?.total || 0;
const todaysCount = todaysPayoutsResult[0]?.count || 0;

// 3. Active ROI Contracts


const activeContractsCount = await MemberModel.countDocuments({
  status: "active",
  roi_status: "Active"
});

return res.status(200).json({
  success: true,
  data: {
    totalROIDistributed,
    todaysTotal,
    todaysCount,
    activeContractsCount,
    lastUpdated: new Date().toISOString()
  }
});
  } catch (error) {
  console.error("Error in getROISummary:", error);
  return res.status(500).json({
    success: false,
    message: "Server error",
    error: error.message,
  });
}
};


const triggerUserROI = async (req, res) => {
  try {
    const { member_id } = req.params;
    if (!member_id) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }

    console.log(`🎯 [ROI] Force Global Trigger by Member: ${member_id}`);
    const result = await processDailyROI();

    return res.status(200).json({
      success: true,
      message: "ROI check completed",
      data: result
    });
  } catch (error) {
    console.error("❌ Error in triggerUserROI:", error);
    return res.status(500).json({
      success: false,
      message: "Error processing ROI",
      error: error.message
    });
  }
};

module.exports = {
  triggerMLMCommissions,
  updateReferralHierarchy,
  getMemberCommissionSummary,
  getDailyPayout,
  climeRewardLoan,
  getRewardLoansByStatus,
  processRewardLoan,
  repaymentLoan,
  triggerDailyROI,
  triggerUserROI,
  getROIBenefits,
  getROISummary,
};

