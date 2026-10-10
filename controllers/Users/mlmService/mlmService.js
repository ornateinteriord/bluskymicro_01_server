const MemberModel = require("../../../models/Users/Member");
const PayoutModel = require("../../../models/Payout/Payout");
const TransactionModel = require("../../../models/Transaction/Transaction");
const CommissionModel = require("../../../models/commission.model");

const referralCommissionPercentages = {
  1: 10,
  2: 3,
  3: 2,
  4: 1,
  5: 1,
  6: 1,
  7: 1
};

const levelBenefitsPercentages = {
  1: 10,
  2: 3,
  3: 2,
  4: 1,
  5: 1,
  6: 1,
  7: 1
};

/*
const roiCommissionPercentages = {
  1: 20,
  2: 3,
  3: 1,
  4: 1,
  5: 1,
  6: 1,
  7: 1,
  8: 1,
  9: 1,
  10: 1
};
*/

const getOrdinal = (number) => {
  const suffixes = ["th", "st", "nd", "rd"];
  const value = number % 100;
  return number + (suffixes[(value - 20) % 10] || suffixes[value] || suffixes[0]);
};

const findUplineSponsors = async (memberId, maxLevels = 15) => {
  const uplineSponsors = [];
  let currentMemberId = memberId;
  let level = 0;

  while (level < maxLevels) {
    const currentMember = await MemberModel.findOne({
      $or: [{ Member_id: currentMemberId }, { member_id: currentMemberId }]
    });

const sponsorIdentifier = currentMember?.sponsor_id || currentMember?.Sponsor_code || currentMember?.introducer;
if (!currentMember || !sponsorIdentifier) {
  break; // No more sponsors in the chain
}

const sponsor = await MemberModel.findOne({
      $or: [{ Member_id: sponsorIdentifier }, { member_id: sponsorIdentifier }, { member_code: sponsorIdentifier }]
    });
if (!sponsor) {
  break; // Sponsor not found
}

level++;
uplineSponsors.push({
  level: level,
  sponsor_id: sponsor.Member_id,
  Sponsor_code: sponsor.member_code || sponsor.Member_id,
  sponsor_name: sponsor.Name,
  sponsor_mobileno: sponsor.mobileno,
  sponsored_member_id: currentMemberId, // The member who triggered this commission
  sponsor_status: sponsor.status
});

// Move up the chain
currentMemberId = sponsor.Member_id || sponsor.member_id;
  }

// console.log(`📊 Found ${uplineSponsors.length} upline sponsors for member ${memberId}`);
return uplineSponsors;
};


const calculateCommissions = async (newMemberId, directSponsorId, specificAmount = null, pkgType = "Base") => {
  try {
    // Find the new member
    const newMember = await MemberModel.findOne({ Member_id: newMemberId });
    if (!newMember) {
      console.error(`❌ New member ${newMemberId} not found for commission calculation`);
      return [];
    }

    const packageValue = specificAmount !== null ? specificAmount : Number(newMember.package_value || newMember.spackage || 0);
    if (!packageValue || packageValue <= 0) {
      console.log(`⚠️ New member ${newMemberId} has invalid package amount: ${packageValue}`);
      return [];
    }


    // Find all upline sponsors up to 7 levels
    const uplineSponsors = await findUplineSponsors(newMemberId, 7);

    if (uplineSponsors.length === 0) {
      return [];
    }

    const commissions = [];

    // Process each upline sponsor
    for (const upline of uplineSponsors) {
      // Only active sponsors are eligible for commissions
      if (upline.sponsor_status !== 'active') {
        continue;
      }

      // --- 1. Calculate Referral Level Income ---
      const refPercentage = referralCommissionPercentages[upline.level] || 0;
      if (refPercentage > 0 && upline.level === 1) {
        const refAmount = Number(((packageValue * refPercentage) / 100).toFixed(2));
        if (refAmount > 0) {
          commissions.push({
            level: upline.level,
            sponsor_id: upline.sponsor_id,
            Sponsor_code: upline.Sponsor_code,
            sponsor_name: upline.sponsor_name,
            sponsor_mobileno: upline.sponsor_mobileno,
            sponsored_member_id: upline.sponsored_member_id,
            new_member_id: newMemberId,
            new_member_name: newMember.Name,
            amount: refAmount,
            percentage: refPercentage,
            packageValue: packageValue,
            payout_type: `Level ${upline.level} Referral Bonus (Invest Amount)`,
            description: `Level ${upline.level} Referral commission (${refPercentage}%) from member ${newMemberId}'s investment (₹${packageValue})`,
            sponsor_status: upline.sponsor_status
          });
          console.log(`✅ [REFERRAL BONUS] Level ${upline.level}: ${upline.sponsor_name} (${upline.sponsor_id}) gets ₹${refAmount} (${refPercentage}%)`);
        }
      }

      // --- 2. Calculate Level Benefits Income ---
      const levelPercentage = levelBenefitsPercentages[upline.level] || 0;
      if (levelPercentage > 0 && upline.level > 1) {
        const levelAmount = Number(((packageValue * levelPercentage) / 100).toFixed(2));
        if (levelAmount > 0) {
          commissions.push({
            level: upline.level,
            sponsor_id: upline.sponsor_id,
            Sponsor_code: upline.Sponsor_code,
            sponsor_name: upline.sponsor_name,
            sponsor_mobileno: upline.sponsor_mobileno,
            sponsored_member_id: upline.sponsored_member_id,
            new_member_id: newMemberId,
            new_member_name: newMember.Name,
            amount: levelAmount,
            percentage: levelPercentage,
            packageValue: packageValue,
            payout_type: `Level ${upline.level} Level Bonus (Invest Amount)`,
            description: `Level ${upline.level} Benefits commission (${levelPercentage}%) from member ${newMemberId}'s investment (₹${packageValue})`,
            sponsor_status: upline.sponsor_status
          });
          console.log(`✅ [LEVEL BONUS] Level ${upline.level}: ${upline.sponsor_name} (${upline.sponsor_id}) gets ₹${levelAmount} (${levelPercentage}%)`);
        }
      }
    }

    return commissions;

  } catch (error) {
    console.error("❌ Error calculating commissions:", error);
    throw error;
  }
};

/**
 * Processes commissions by creating payouts and transactions for each eligible sponsor
 * 
 * @param {Array} commissions - Array of commission objects from calculateCommissions
 * @returns {Array} Array of results with success/failure status for each commission
 */
const processCommissions = async (commissions, session = null) => {
  try {
    const results = [];

    for (const commission of commissions) {
      try {
        // Verify sponsor is still active before processing
        const sponsor = await MemberModel.findOne({ Member_id: commission.sponsor_id }).session(session);

        if (!sponsor || sponsor.status !== 'active') {
          results.push({
            success: false,
            level: commission.level,
            sponsor_id: commission.sponsor_id,
            sponsor_name: commission.sponsor_name,
            error: `Sponsor status is not active (${sponsor?.status || 'not found'})`
          });
          continue;
        }

        // Generate unique payout ID
        const payoutId = Date.now() + Math.floor(Math.random() * 1000) + commission.level + Math.floor(Math.random() * 1000);

        // Create payout record
        const payout = new PayoutModel({
          payout_id: payoutId.toString(),
          date: new Date().toISOString().split('T')[0],
          memberId: commission.sponsor_id,
          payout_type: commission.payout_type,
          ref_no: commission.new_member_id,
          amount: commission.amount,
          level: commission.level,
          sponsored_member_id: commission.new_member_id,
          sponsor_id: commission.sponsor_id,
          status: "Completed",
          Name: sponsor.Name,
          mobileno: sponsor.mobileno,
          description: commission.description,
          sponsor_status: commission.sponsor_status
        });

        await payout.save({ session });

        // Create transaction record for wallet credit
        const transaction = await createLevelBenefitsTransaction({
          payout_id: payoutId.toString(),
          memberId: commission.sponsor_id,
          payout_type: commission.payout_type,
          amount: commission.amount,
          level: commission.level,
          new_member_id: commission.new_member_id,
          new_member_name: commission.new_member_name,
          sponsor_name: sponsor.Name,
          sponsor_mobileno: sponsor.mobileno
        }, session);

        // Create commission record
        const commissionRecord = new CommissionModel({
          commission_id: `COM-${payoutId}`,
          beneficiary_id: commission.sponsor_id,
          beneficiary_name: sponsor.Name || commission.sponsor_name,
          beneficiary_type: "MEMBER",
          source_id: commission.new_member_id,
          source_name: commission.new_member_name,
          source_type: "MEMBER",
          transaction_id: transaction.transaction_id,
          transaction_date: new Date(),
          account_type: commission.payout_type,
          account_type_id: "MLM_LEVEL_INCOME",
          transaction_amount: commission.packageValue || 0,
          commission_rate: commission.percentage || 0,
          commission_amount: commission.amount,
          level: commission.level,
          status: "CREDITED",
          credited_at: new Date()
        });

        await commissionRecord.save({ session });

        results.push({
          success: true,
          level: commission.level,
          amount: commission.amount
        });

      } catch (error) {
        console.error(`❌ Error processing commission for level ${commission.level} (${commission.sponsor_id}):`, error);
        results.push({
          success: false,
          error: error.message
        });
      }
    }

    return results;

  } catch (error) {
    console.error("❌ Error in processCommissions:", error);
    throw error;
  }
};

const createLevelBenefitsTransaction = async (transactionData, session = null) => {
  try {
    const { payout_id, memberId, payout_type, amount, level, new_member_id, new_member_name, sponsor_name, sponsor_mobileno } = transactionData;

    // Fixed: Performance optimization - don't query for last ID on every iteration
    // Use a unique compound ID to ensure consistency and speed in high-concurrency 
    const newTransactionId = `T-L-${payout_id}-${Math.floor(Math.random() * 1000)}`;

    // 100% Main Wallet (Credits/Withdrawal) - Retopup wallet not required
    const mainWalletAmount = Number(amount.toFixed(2));

    const transaction = new TransactionModel({
      transaction_id: newTransactionId,
      transaction_date: new Date(),
      member_id: memberId,
      Name: sponsor_name,
      mobileno: sponsor_mobileno,
      reference_no: payout_id.toString(),
      description: payout_type,
      transaction_type: payout_type.includes('Referral Bonus') ? "Referral Bonus" : "Level Bonus",
      ew_credit: mainWalletAmount.toString(),
      tw_credit: "0",
      uw_credit: "0",
      fd_credit: "0",
      pw_credit: "0",
      ew_debit: "0",
      status: "Completed",
      level: level,
      benefit_type: level === 1 ? "direct" : "indirect",
      related_member_id: new_member_id,
      related_member_name: new_member_name,
      related_payout_id: payout_id
    });

    await transaction.save({ session });

    // Add full amount to sponsor's credits wallet
    await MemberModel.findOneAndUpdate(
      { Member_id: memberId },
      { 
        $inc: {
          wallet_balance: mainWalletAmount
        } 
      },
      { session }
    );

return transaction;

  } catch (error) {
  console.error("❌ Error creating transaction:", error);
  throw error;
}
};

const updateSponsorReferrals = async (sponsorId, newMemberId) => {
  try {
    const sponsorQuery = { $or: [{ Member_id: sponsorId }, { member_id: sponsorId }] };
    const sponsor = await MemberModel.findOne(sponsorQuery);
    if (!sponsor) {
      console.error(`Sponsor not found: ${sponsorId}`);
      return;
    }
    await MemberModel.findOneAndUpdate(
      sponsorQuery,
      {
        $addToSet: { direct_referrals: newMemberId },
        $inc: { total_team: 1 }
      }
    );

console.log(`✅ Updated referrals for ${sponsorId}: Added ${newMemberId}`);

  } catch (error) {
  console.error("❌ Error updating referrals:", error);
  throw error;
}
};

const getUplineTree = async (memberId, maxLevels = 15) => {
  return []; // DISABLED
  /*
  try {
    const tree = [];
    let currentMemberId = memberId;
    let level = 0;

    while (level < maxLevels) {
      const currentMember = await MemberModel.findOne({ Member_id: currentMemberId });

      if (!currentMember || !currentMember.sponsor_id) {
        break;
      }

      const sponsor = await MemberModel.findOne({ Member_id: currentMember.sponsor_id });
      if (sponsor) {
        level++;
        tree.push({
          level: level,
          member_id: sponsor.Member_id,
          name: sponsor.Name,
          member_code: sponsor.member_code,
          status: sponsor.status,
          direct_referrals: sponsor.direct_referrals || [],
          total_team: sponsor.total_team || 0,
          commission_rate: commissionRates[level],
          eligible: sponsor.status === 'active'
        });

        currentMemberId = sponsor.Member_id;
      } else {
        break;
      }
    }

    return tree;
  } catch (error) {
    console.error("❌ Error getting upline tree:", error);
    throw error;
  }
  */
};

const getCommissionSummary = () => {
  return {
    total_levels: 7,
    referral_rates: referralCommissionPercentages,
    level_rates: levelBenefitsPercentages,
    // roi_rates: roiCommissionPercentages, // Disabled as per user request (NO ROI)
    condition: "Commissions only for sponsors with 'active' status"
  };
};

const processMemberActivation = async (activatedMemberId) => {
  return { success: false, message: "Commissions Disabled" };
  /*
  try {
    const member = await MemberModel.findOne({ Member_id: activatedMemberId });
    if (!member) {
      return { success: false, message: "Member not found" };
    }

    let sponsor = null;
    if (member.sponsor_id) {
      sponsor = await MemberModel.findOne({ Member_id: member.sponsor_id });
    }

    if (!sponsor) {
      return { success: false, message: "Sponsor not found" };
    }

    if (sponsor.status !== "active") {
      await updateSponsorReferrals(sponsor.Member_id, member.Member_id).catch(e => console.error(e));
      return { success: false, message: "Sponsor not active; payout skipped" };
    }

    const amount = commissionRates[1] || 0;
    if (amount <= 0) {
      return { success: false, message: "No commission configured for level 1" };
    }

    const payoutId = Date.now() + Math.floor(Math.random() * 1000) + 1;

    const payout = new PayoutModel({
      payout_id: payoutId,
      date: new Date().toISOString().split("T")[0],
      memberId: sponsor.Member_id,
      payout_type: `1st Level Benefits`,
      ref_no: member.Member_id,
      amount: amount,
      level: 1,
      sponsored_member_id: member.Member_id,
      sponsor_id: sponsor.Member_id,
      status: "Completed",
      description: `Direct referral commission from ${member.Member_id}`
    });

    await payout.save();

    const transaction = await createLevelBenefitsTransaction({
      payout_id: payoutId,
      memberId: sponsor.Member_id,
      payout_type: payout.payout_type,
      amount: amount,
      level: 1,
      new_member_id: member.Member_id
    });

    await updateSponsorReferrals(sponsor.Member_id, member.Member_id);

    return {
      success: true,
      payout,
      transaction
    };

  } catch (error) {
    console.error("❌ Error in processMemberActivation:", error);
    throw error;
  }
  */
};

/**
 * Distributes commission to 10 levels of upline sponsors when a member receives ROI
 * 
 * @param {string} memberId - The member ID who received ROI
 * @param {number} roiAmount - The ROI amount received
 * @returns {Promise<Array>} Results of commission distribution
 */
/* DISABLED AS PER USER REQUEST (NO ROI)
const distributeROICommission = async (memberId, roiAmount, session = null, customDate = null, sourceRef = "Base") => {
  try {
    if (!roiAmount || roiAmount <= 0) return [];

    // Find the source member to get their name
    const sourceMember = await MemberModel.findOne({ Member_id: memberId }).session(session);
    if (!sourceMember) return [];

    // Find all upline sponsors up to 10 levels
    const uplineSponsors = await findUplineSponsors(memberId, 10);
    if (uplineSponsors.length === 0) return [];

    const results = [];

    for (const upline of uplineSponsors) {
      // Only active sponsors are eligible for commissions
      if (upline.sponsor_status !== 'active') {
        results.push({
          level: upline.level,
          sponsor_id: upline.sponsor_id,
          success: false,
          error: "Sponsor not active"
        });
        continue;
      }

      // Get percentage based on level
      const percentage = roiCommissionPercentages[upline.level] || 0;
      if (percentage <= 0) continue;

      const commissionAmount = Number(((roiAmount * percentage) / 100).toFixed(2));
      if (commissionAmount <= 0) continue;

      const payoutId = Date.now() + Math.floor(Math.random() * 1000) + upline.level + Math.floor(Math.random() * 1000);
      const today = customDate || new Date().toISOString().split('T')[0];

      // Create payout record
      const payout = new PayoutModel({
        payout_id: payoutId.toString(),
        date: today,
        memberId: upline.sponsor_id,
        payout_type: "ROI Level Benefit",
        // ✅ FIXED: ref_no must be unique per day/member/level/source to avoid DB collision
        ref_no: `ROI-L-${memberId}-${upline.level}-${today}-${sourceRef}`,
        amount: commissionAmount,
        level: upline.level,
        sponsored_member_id: memberId,
        sponsor_id: upline.sponsor_id,
        status: "Completed",
        Name: upline.sponsor_name,
        mobileno: upline.sponsor_mobileno,
        description: `ROI Level ${upline.level} benefit (${percentage}%) from member ${memberId}'s ROI (₹${roiAmount})`,
        sponsor_status: upline.sponsor_status
      });

      await payout.save({ session });

      // Fixed: Use unique transaction ID based on payoutId to skip slow DB reads
      const newTransactionId = `T-ROI-L-${payoutId}-${Math.floor(Math.random() * 1000)}`;

      const transaction = new TransactionModel({
        transaction_id: newTransactionId,
        transaction_date: today,
        member_id: upline.sponsor_id,
        Name: upline.sponsor_name,
        mobileno: upline.sponsor_mobileno,
        reference_no: payoutId.toString(),
        description: `ROI Level ${upline.level} Benefit`,
        transaction_type: "ROI Level Benefit",
        ew_credit: commissionAmount.toString(),
        ew_debit: "0",
        status: "Completed",
        level: upline.level,
        benefit_type: "ROI Level Income",
        related_member_id: memberId,
        related_member_name: sourceMember.Name,
        related_payout_id: payoutId
      });

      await transaction.save({ session });

      // Add amount to sponsor's wallet balance
      await MemberModel.findOneAndUpdate(
        { Member_id: upline.sponsor_id },
        { $inc: { wallet_balance: commissionAmount } },
        { session }
      );

      results.push({
        level: upline.level,
        sponsor_id: upline.sponsor_id,
        amount: commissionAmount,
        success: true
      });

      console.log(`💰 ROI Level ${upline.level}: ${upline.sponsor_id} gets ₹${commissionAmount} from ${memberId}`);
    }

    return results;

  } catch (error) {
    console.error("❌ Error in distributeROICommission:", error);
    throw error;
  }
};
*/
const distributeROICommission = async (memberId, roiAmount, session = null, customDate = null, sourceRef = "Base") => {
  return [];
};

module.exports = {
  referralCommissionPercentages,
  levelBenefitsPercentages,
  commissionRates: levelBenefitsPercentages,
  // roiCommissionPercentages, // Disabled as per user request
  getOrdinal,
  findUplineSponsors,
  createLevelBenefitsTransaction,
  updateSponsorReferrals,
  calculateCommissions,
  processCommissions,
  getUplineTree,
  getCommissionSummary,
  processMemberActivation,
  distributeROICommission
};
