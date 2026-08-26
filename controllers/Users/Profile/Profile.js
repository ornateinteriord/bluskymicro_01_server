const MemberModel = require("../../../models/Users/Member");
const mongoose = require("mongoose");
const moment = require("moment");
const AdminModel = require("../../../models/Admin/Admin");
const TransactionModel = require("../../../models/Transaction/Transaction");
const PayoutModel = require("../../../models/Payout/Payout");
const { triggerMLMCommissions } = require("../Payout/PayoutController");
const { processMemberROI } = require("../roiService/roiService");
const AddOnPackageModel = require("../../../models/Packages/AddOnPackage");

const getMemberDetails = async (req, res) => {
  try {
    const id = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid User ID"
      });
    }

    const foundUser = await MemberModel.findById(id) || await AdminModel.findById(id);

    if (!foundUser) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // If admin, return all members with their total package value
    if (foundUser instanceof AdminModel) {
      const members = await MemberModel.aggregate([
        {
          $lookup: {
            from: "add_on_package_tbl",
            localField: "Member_id",
            foreignField: "member_id",
            as: "addons"
          }
        },
        {
          $addFields: {
            // Calculate total sum of all packages (Primary + Add-ons)
            total_package_value: {
              $add: [
                { $ifNull: ["$package_value", 0] },
                { $sum: "$addons.amount" }
              ]
            }
          }
        },
        {
          $sort: { createdAt: -1 } // Optional: Keep recent members at top
        }
      ]);

      return res.status(200).json({
        success: true,
        data: foundUser,
        members
      });
    }

    // For regular members - get actual registration counts from database
    const directCount = await MemberModel.countDocuments({
      $or: [
        { introducer: foundUser.Member_id },
        { sponsor_id: foundUser.Member_id },
        { Sponsor_code: foundUser.Member_id }
      ]
    });

    const totalTeamCount = await MemberModel.countDocuments({
      $or: [
        { introducer_hierarchy: foundUser.Member_id },
        { referral_path: { $regex: foundUser.Member_id, $options: 'i' } }
      ]
    });

    const indirectCount = totalTeamCount - directCount;

    if (!foundUser.qr_code && (foundUser.Member_id || foundUser.member_id)) {
      foundUser.qr_code = `BMS-P2P:${foundUser.Member_id || foundUser.member_id}`;
      await foundUser.save();
    }

    const idStr = String(foundUser.Member_id || foundUser.member_id || '1');
    let numericPart = idStr.replace(/\D/g, '');
    if (!numericPart) {
      let seed = 5381;
      for (let i = 0; i < idStr.length; i++) {
        seed = (seed * 33) ^ idStr.charCodeAt(i);
      }
      numericPart = String(Math.abs(seed));
    }
    const last6 = numericPart.padStart(6, '0').slice(-6);
    const virtual_card_number = ('4638292644' + last6).replace(/(.{4})/g, '$1 ').trim();

    // Add registration data to response
    const responseData = {
      ...foundUser.toObject(),
      virtual_card_number,
      qr_code: foundUser.qr_code || `BMS-P2P:${foundUser.Member_id || foundUser.member_id}`,
      registration_stats: {
        direct: directCount,
        indirect: indirectCount,
        total: totalTeamCount
      }
    };

    return res.status(200).json({
      success: true,
      data: responseData
    });

  } catch (error) {
    console.error("Error fetching User details:", error);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

const activateMemberPackage = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ success: false, message: "Access Denied" });
    }

    const { memberId } = req.params;
    const { packageType } = req.body;
    if (!memberId || !packageType) {
      return res.status(400).json({ success: false, message: "Member ID and package type are required" });
    }

    const existingMember = await MemberModel.findOne({ Member_id: memberId });
    if (!existingMember) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    // Dynamically accept any BMS Plan amount or "NONE"
    let selectedPackage = null;
    if (packageType === "NONE") {
      selectedPackage = { name: "NONE", value: 0 };
    } else if (packageType && packageType.startsWith("BMS_")) {
      const amtStr = packageType.replace("BMS_", "");
      const amt = Number(amtStr);
      if (!isNaN(amt) && amt > 0) {
        selectedPackage = { name: `PKG-${amt}`, value: amt };
      }
    }

    if (!selectedPackage) {
      return res.status(400).json({ success: false, message: "Invalid package selection" });
    }

    const activationDate = moment().utcOffset("+05:30").format("YYYY-MM-DD");

    // ── CASE A: Activation WITHOUT Package ──
    if (selectedPackage.name === "NONE") {
      console.log(`👤 [Activation] Activating ${memberId} WITHOUT package.`);

      const updatedMember = await MemberModel.findOneAndUpdate(
        { Member_id: memberId },
        {
          status: "active",
          Date_of_joining: activationDate
        },
        { new: true }
      );

      return res.status(200).json({
        success: true,
        data: updatedMember,
        message: "Member activated successfully without a package."
      });
    }

    // ── CASE B: Activation WITH Package ──
    const amount = selectedPackage.value;
    console.log(`💎 [Activation] Activating ${memberId} WITH ₹${amount} package.`);

    // 1. Update member_tbl basic status
    const updatedMember = await MemberModel.findOneAndUpdate(
      { Member_id: memberId },
      {
        status: "active",
        spackage: selectedPackage.name,
        package_value: amount,
        upgrade_status: "Active", // Activated with package
        Date_of_joining: activationDate,
      },
      { new: true }
    );

    if (!updatedMember) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    // 2. ✅ STORE IN ADD_ON PACKAGE TABLE (as requested)
    const newAddOn = new AddOnPackageModel({
      package_id: `PKG-P-${Date.now()}`, // P for Primary
      member_id: memberId,
      amount: amount,
      roi_status: "Active",
      roi_payout_target: amount * 3,
      roi_payout_count: 0,
      roi_start_date: activationDate,
      roi_last_payout_date: activationDate,
      admin_id: req.user.id || "ADMIN"
    });
    await newAddOn.save();



    // 3. ✅ CREATE "DAY 0" PAYOUT AND TRANSACTION (₹0 records)
    const payoutId = Date.now() + Math.floor(Math.random() * 1000);
    const payout = new PayoutModel({
      payout_id: payoutId,
      date: moment().utcOffset("+05:30").toDate(),
      memberId: memberId,
      payout_type: "ROI (Primary)",
      ref_no: `ACT-P-${newAddOn.package_id}-0`,
      amount: 0,
      count: 0,
      days: 300,
      status: "Approved",
      description: "Primary Package Activation"
    });

    const activationTx = new TransactionModel({
      transaction_id: `ACT-P-TX-${payoutId}`,
      transaction_date: activationDate,
      member_id: memberId,
      Name: updatedMember.Name,
      mobileno: updatedMember.mobileno,
      description: `Package Activation – Day 0/300 (₹${amount} pkg)`,
      transaction_type: "ROI Payout",
      ew_credit: "0",
      ew_debit: "0",
      status: "Completed",
      benefit_type: "ROI",
      reference_no: payout.ref_no
    });

    await Promise.all([payout.save(), activationTx.save()]);

    // 4. ✅ Trigger MLM level commissions
    try {
      req.body.new_member_id = memberId;
      req.body.Sponsor_code = updatedMember.Sponsor_code;

      const mlmResult = await triggerMLMCommissions(req, {
        status: (code) => ({ json: (data) => data }),
        json: (data) => data
      });

      return res.status(200).json({
        success: true,
        data: updatedMember,
        message: `${selectedPackage.name} activated and stored in add-on table.`,
        mlm_result: mlmResult
      });
    } catch (mlmError) {
      console.error("❌ MLM Error during activation:", mlmError);
      return res.status(200).json({
        success: true,
        data: updatedMember,
        message: "Member activated with package, but referral update failed.",
        mlm_error: mlmError.message
      });
    }

  } catch (error) {
    console.error("Error activating package:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
};

const getMember = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res
        .status(403)
        .json({ success: false, message: "Access Denied", });
    }
    const memberId = req.params.memberId
    const member = await MemberModel.findOne({ Member_id: memberId })
    if (!member) {
      return res
        .status(404)
        .json({ success: false, message: "Member not found", });
    }
    return res.status(200).json({ success: true, member });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

const UpdateMemberDetails = async (req, res) => {
  try {
    let memberId;

    if (req.user.role === "ADMIN") {
      memberId = req.params.memberId;
    } else {
      memberId = req.user.memberId;
    }

    if (!memberId) {
      return res.status(400).json({
        success: false,
        message: "Member ID is required",
      });
    }

    const { oldPassword, newPassword, ...updateData } = req.body;

    // Find the user by Member_id (not _id)
    const foundUser = await MemberModel.findOne({ Member_id: memberId });

    if (!foundUser) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    // Handle password update
    if (oldPassword && newPassword) {
      if (oldPassword !== foundUser.password) {
        return res.status(401).json({
          success: false,
          message: "Old password is incorrect",
        });
      }
      if (oldPassword === newPassword) {
        return res.status(400).json({
          success: false,
          message: "New password cannot be the same as old password",
        });
      }
      if (newPassword.length <= 5) {
        return res.status(400).json({
          success: false,
          message: "Password must be at least 6 characters long",
        });
      }

      updateData.password = newPassword;
    }

    // Update user details
    const updatedMember = await MemberModel.findOneAndUpdate(
      { Member_id: memberId },
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!updatedMember) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Member details updated successfully",
      data: updatedMember,
    });
  } catch (error) {
    console.error("Error updating member details:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};
const updateMemberStatus = async (req, res) => {
  try {
    const { memberId } = req.params;
    const { status, upgrade_status } = req.body;

    if (!status && !upgrade_status) {
      return res.status(400).json({ success: false, message: "Status or Upgrade Status is required" });
    }

    let query;
    if (mongoose.Types.ObjectId.isValid(memberId)) {
      query = { _id: memberId };
    } else {
      query = { Member_id: memberId };
    }

    const existingMember = await MemberModel.findOne(query);
    if (!existingMember) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const activationDate = moment().utcOffset("+05:30").format("YYYY-MM-DD");
    const updatePayload = {};

    // Handle main status update
    if (status) {
      if (status === 'active' && existingMember.status === 'active') {
        return res.status(400).json({ success: false, message: "Member is already active." });
      }
      updatePayload.status = status;
    }

    // Handle upgrade_status (UI visibility) update
    if (upgrade_status) {
      updatePayload.upgrade_status = upgrade_status;
    }

    // Special logic for first-time activation from Pending
    if (existingMember.upgrade_status === "Pending" && status === "active") {
      updatePayload.roi_status = 'Active';
      updatePayload.upgrade_status = 'Active';
      updatePayload.roi_payout_count = 0;
      updatePayload.roi_start_date = activationDate;
      updatePayload.roi_last_payout_date = activationDate;
      if (existingMember.package_value && existingMember.package_value > 0) {
        updatePayload.roi_payout_target = (existingMember.package_value || 0) * 3;
      }
    }

    const updatedMember = await MemberModel.findOneAndUpdate(query, { $set: updatePayload }, { new: true });

    // ✅ Create "Day 0" Payout and Transaction if newly activated (from Pending)
    if (existingMember.upgrade_status === "Pending" && status === "active") {
      const payoutId = Date.now() + Math.floor(Math.random() * 1000);
      const payout = new PayoutModel({
        payout_id: payoutId,
        date: moment().utcOffset("+05:30").toDate(),
        memberId: updatedMember.Member_id,
        payout_type: "ROI",
        ref_no: `ACT-${updatedMember.Member_id}-0`,
        amount: 0,
        count: 0,
        days: 300,
        status: "Approved",
        description: "Package Activation"
      });

      const activationTx = new TransactionModel({
        transaction_id: `ACT-TX-${payoutId}`,
        transaction_date: activationDate,
        member_id: updatedMember.Member_id,
        Name: updatedMember.Name,
        mobileno: updatedMember.mobileno,
        description: `Package Activation – Daily ROI (Day 0/300)`,
        transaction_type: "ROI Payout",
        ew_credit: "0",
        ew_debit: "0",
        status: "Completed",
        benefit_type: "ROI",
        reference_no: payout.ref_no
      });
      await Promise.all([payout.save(), activationTx.save()]);

      try {
        // Trigger MLM commissions
        await triggerMLMCommissions({
          body: {
            new_member_id: updatedMember.Member_id,
            Sponsor_code: updatedMember.sponsor_id || updatedMember.Sponsor_code
          }
        }, {
          status: (code) => ({ json: (data) => data }),
          json: (data) => data
        });
      } catch (mlmError) {
        console.error("MLM Commission Error:", mlmError);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Member status updated",
      data: updatedMember
    });
  } catch (error) {
    console.error("Error updating member status:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = { getMemberDetails, UpdateMemberDetails, getMember, activateMemberPackage, updateMemberStatus };
