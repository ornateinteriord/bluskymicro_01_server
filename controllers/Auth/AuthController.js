const AdminModel = require("../../models/Admin/Admin");
const MemberModel = require("../../models/Users/Member");
const jwt = require("jsonwebtoken");
const {
  sendMail,
} = require("../../utils/EmailService");
const { generateOTP, storeOTP, verifyOTP } = require("../../utils/OtpService");
const admin = require("../../utils/FirebaseService");
const { generateMSCSEmail } = require("../../utils/generateMSCSEmail");
const { updateSponsorReferrals } = require("../../controllers/Users/mlmService/mlmService");
const { addMemberHierarchy } = require("../../utils/hierarchyHelper");
const path = require("path");

const recoverySubject = "BMS - Password Recovery";
const resetPasswordSubject = "BMS - OTP Verification";

const generateUniqueMemberId = async () => {
  let newNumber = 1;
  // Get the most recently created member (sorted by _id)
  const lastMember = await MemberModel.findOne().sort({ _id: -1 });

  if (lastMember && lastMember.Member_id) {
    const lastNumberStr = lastMember.Member_id.replace('BMS', '');
    const lastNumber = parseInt(lastNumberStr, 10);
    if (!isNaN(lastNumber) && lastNumber >= 1) {
      newNumber = lastNumber + 1;
    }
  }

  let finalId = String(newNumber).padStart(6, '0');

  // Guarantee uniqueness against both legacy BMS-prefixed IDs and new purely numeric IDs
  while (await MemberModel.exists({ Member_id: finalId }) || await MemberModel.exists({ Member_id: `BMS${String(newNumber).padStart(5, '0')}` })) {
    newNumber++;
    finalId = String(newNumber).padStart(6, '0');
  }
  return finalId;
};

const signup = async (req, res) => {
  try {
    const { email, password, Name, sponsorId, ...otherDetails } = req.body;
    // const existingUser = await MemberModel.findOne({ email });
    // if (existingUser) {
    //   return res.status(400).json({ success: false, message: "Email already in use" });
    // }

    const memberId = await generateUniqueMemberId();

    // Find the sponsor if provided
    let sponsor = null;
    if (sponsorId) {
      sponsor = await MemberModel.findOne({ Member_id: sponsorId });
      if (!sponsor) {
        return res.status(400).json({ success: false, message: "Invalid sponsor ID" });
      }
    }

    let memberData = {
      Member_id: memberId,
      qr_code: `BMS-P2P:${memberId}`,
      email,
      password,
      Name,

      // Assign sponsor if provided
      sponsor_id: sponsorId || null,
      Sponsor_code: sponsorId || null,
      Sponsor_name: sponsor ? sponsor.Name : null,

      introducer: sponsorId || null,
      introducer_name: sponsor ? sponsor.Name : null,

      ...otherDetails,
    };

    // Automatically build introducer hierarchy
    memberData = await addMemberHierarchy(memberData);

    const newMember = new MemberModel(memberData);
    await newMember.save();

    // If a sponsor was provided, add this member to the sponsor's direct referrals
    if (sponsorId) {
      try {
        await updateSponsorReferrals(sponsorId, memberId);
        console.log(`✅ Added new member ${memberId} to sponsor ${sponsorId}'s direct referrals`);
      } catch (referralError) {
        console.error("Error updating sponsor referrals:", referralError);
      }
    }

    try {

      const { welcomeMessage, welcomeSubject } = generateMSCSEmail(memberId, password, Name);

      const textContent = `Dear ${Name}, Your account registration with BMS has been completed. Member ID: ${memberId}, Password: ${password}. Your account is under verification process.`;

      const attachments = [{
        filename: 'BMS.png',
        path: path.join(__dirname, '../../utils/BMS.png'),
        cid: 'bmslogo'
      }];

      await sendMail(email, welcomeSubject, welcomeMessage, textContent, attachments);

    } catch (emailError) {
      console.error("Error sending welcome email:", emailError);
    }

    res.status(201).json({
      success: true,
      message: "Signup successful. Credentials sent to email.",
      user: {
        Member_id: newMember.Member_id,
        email: newMember.email,
        Name: newMember.Name
      },
    });

  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const getSponsorDetails = async (req, res) => {
  try {
    const { ref } = req.params;
    const sponsor = await MemberModel.findOne({ Member_id: ref });
    if (!sponsor) {
      return res
        .status(404)
        .json({ success: false, message: "Invalid Sponsor Code" });
    }
    res.json({
      success: true,
      Member_id: sponsor.Member_id,
      name: sponsor.Name,
      status: sponsor.status || "Pending",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { mobileno, password, otp } = req.body;

    if (!mobileno || !password || !otp) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    let searchPhone = mobileno;
    // Format the phone number since MongoDB stores it without +91 sometimes or with +91.
    // Try finding exact match, or match without +91, or match with +91
    let user = await MemberModel.findOne({
      $or: [
        { mobileno: searchPhone },
        { mobileno: searchPhone.replace('+91', '') },
        { mobileno: '+91' + searchPhone.replace('+91', '') }
      ]
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "Mobile number not registered" });
    }

    try {
      // Verify Firebase token
      const decodedToken = await admin.auth().verifyIdToken(otp);
      const phoneVerified = decodedToken.phone_number;

      let memberPhone = String(user.mobileno).trim().replace(/\s+/g, '');
      if (!memberPhone.startsWith('+')) {
        memberPhone = '+91' + memberPhone;
      }

      // Also format the phoneVerified to remove +91 for comparison if needed
      let formattedVerifiedPhone = phoneVerified;

      if (formattedVerifiedPhone !== memberPhone) {
        return res.status(400).json({ success: false, message: "Phone number mismatch. Please use your registered mobile number." });
      }

      // Reset password
      user.password = password;
      await user.save();

      return res.json({
        success: true,
        message: "Password reset successfully",
      });
    } catch (firebaseError) {
      console.error("Firebase Verification Error:", firebaseError);
      return res.status(400).json({ success: false, message: "Invalid or expired Firebase token." });
    }
  } catch (error) {
    console.error("Error in resetPassword:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const login = async (req, res) => {
  try {
    const { username, password } = req.body;
    let user = await MemberModel.findOne({ Member_id: username });
    
    // Legacy support: if the username is purely numeric (e.g. 000001), also check if they exist as BMS00001
    if (!user && /^\d+$/.test(username)) {
      const legacyUsername = `BMS${parseInt(username, 10).toString().padStart(5, '0')}`;
      user = await MemberModel.findOne({ Member_id: legacyUsername });
    }
    
    const admin = await AdminModel.findOne({ username });
    const foundUser = user || admin;
    if (!foundUser) {
      return res
        .status(404)
        .json({ success: false, message: "User or Admin not found" });
    }
    const userRole = user instanceof MemberModel ? "USER" : (admin.role || "ADMIN");
    let isPasswordValid = true;
    if (userRole !== "USER") {
      isPasswordValid = password === (foundUser.PASSWORD || foundUser.password);
    }
    
    if (!isPasswordValid) {
      return res
        .status(401)
        .json({ success: false, message: "Incorrect username or password" });
    }

    const token = jwt.sign(
      {
        id: foundUser._id,
        role: userRole,
        memberId: foundUser?.Member_id ?? null,
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );
    return res.status(200).json({

      success: true,
      role: userRole,
      user: foundUser,
      token,
      message: `${userRole.charAt(0).toUpperCase() + userRole.slice(1).toLowerCase()
        } login successful`,

    });

  } catch (error) {
    console.error("Login Error:", error);
    return res
      .status(500)
      .json({ success: false, message: error });
  }
};

const impersonate = async (req, res) => {
  try {
    const { memberId } = req.body;
    if (!memberId) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }

    const member = await MemberModel.findOne({ Member_id: memberId });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const token = jwt.sign(
      {
        id: member._id,
        role: "USER",
        memberId: member.Member_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: "2h" } // Short lived token for impersonation
    );

    return res.status(200).json({
      success: true,
      token,
      message: `Impersonation token generated for ${member.Name}`,
    });
  } catch (error) {
    console.error("Impersonation Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  signup,
  getSponsorDetails,
  resetPassword,
  login,
  impersonate,
};
