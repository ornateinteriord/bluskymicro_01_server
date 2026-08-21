const MemberModel = require("../../models/member.model");
const axios = require("axios");
const cashfreeConfig = require("../../utils/cashfree");

/* =====================================================
   CASHFREE TOKEN CACHE
===================================================== */
let cachedToken = null;
let tokenExpiry = 0;

async function getCashfreeToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  try {
    // Use CI_APP_ID and CI_SECRET_KEY for Cashfree Verification/Payout API
    const clientId = process.env.CI_APP_ID;
    const clientSecret = process.env.CI_SECRET_KEY;

    if (!clientId || !clientSecret) {
      throw new Error("CI_APP_ID or CI_SECRET_KEY not configured in .env");
    }

    console.log("🔑 Attempting Cashfree auth with:");
    console.log("   Client ID:", clientId);
    console.log("   Base URL:", cashfreeConfig.CASHFREE_BASE_URL);

    const res = await axios.post(
      `${cashfreeConfig.CASHFREE_BASE_URL}/payout/v1/authorize`,
      {},
      {
        headers: {
          "X-Client-Id": clientId,
          "X-Client-Secret": clientSecret,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Cashfree auth response:", res.data);

    const token = res.data?.data?.token;
    if (!token) {
      throw new Error("Cashfree auth failed - no token in response");
    }

    cachedToken = token;
    tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 mins
    console.log("✅ Cashfree token obtained successfully");
    return token;
  } catch (error) {
    console.error("❌ Cashfree auth error:", error.message);
    if (error.response) {
      console.error("   Response status:", error.response.status);
      console.error("   Response data:", error.response.data);
    }
    throw new Error(`Cashfree auth failed: ${error.message}`);
  }
}

/* =====================================================
   BANK + NAME VALIDATION (STRICT)
===================================================== */
async function validateBank({ name, bankAccount, ifsc }) {
  const token = await getCashfreeToken();

  const res = await axios.get(
    `${cashfreeConfig.CASHFREE_BASE_URL}/payout/v1/validation/bankDetails`,
    {
      params: { name, bankAccount, ifsc },
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  return res.data;
}

/* =====================================================
   CREATE BENEFICIARY
===================================================== */
async function createBeneficiary(user) {
  if (user.beneficiaryStatus === "CREATED") return;

  const token = await getCashfreeToken();
  const beneficiaryId = `BEN_${user.member_id}`;

  const payload = {
    beneId: beneficiaryId,
    name: user.name,
    email: user.emailid,
    phone: user.contactno,
    bankAccount: user.account_number,
    ifsc: user.ifsc_code,
    address1: user.address || "India",
  };

  const res = await axios.post(
    `${cashfreeConfig.CASHFREE_BASE_URL}/payout/v1/addBeneficiary`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (res.data.status === "SUCCESS") {
    user.beneficiaryId = beneficiaryId;
    user.beneficiaryStatus = "CREATED";
    await user.save();
  }
}

/* =====================================================
   SUBMIT KYC (FULL AUTO – CASHFREE DRIVEN)
===================================================== */
exports.submitKYC = async (req, res) => {
  try {
    const {
      ref_no,
      bankAccount,
      ifsc,
      bankName,
      panImage,
      aadhaarImage,
      checkImage,
      passbookImage,
      rationCardImage,
      profileImage,
      upiId
    } = req.body;

    const member = await MemberModel.findOne({ member_id: ref_no });
    if (!member) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    if (member.kycStatus === "APPROVED") {
      return res.status(400).json({
        success: false,
        message: "KYC already approved",
      });
    }

    // Save details first (audit safety)
    member.account_number = bankAccount || member.account_number;
    member.ifsc_code = ifsc || member.ifsc_code;
    member.bank_name = bankName || member.bank_name;
    member.upi_id = upiId || member.upi_id;
    member.kycStatus = "PROCESSING";
    member.panImage = panImage || member.panImage;
    member.aadhaarImage = aadhaarImage || member.aadhaarImage;
    member.checkImage = checkImage || member.checkImage;
    member.passbookImage = passbookImage || member.passbookImage;
    member.rationCardImage = rationCardImage || member.rationCardImage;
    member.profile_image = profileImage || member.profile_image;

    await member.save();

    // 🧪 SANDBOX BYPASS MODE (For local testing without Cashfree)
    const SANDBOX_BYPASS = process.env.ENABLE_KYC_SANDBOX_BYPASS === "true";

    if (SANDBOX_BYPASS) {
      console.log("🧪 SANDBOX MODE: Bypassing Cashfree validation");
      console.log("   Member:", member.name);
      console.log("   Bank Account:", bankAccount);
      console.log("   IFSC:", ifsc);

      // Auto-approve in sandbox mode
      member.kycStatus = "APPROVED";
      await member.save();

      return res.json({
        success: true,
        message: "KYC approved automatically (SANDBOX MODE)",
        sandbox: true,
      });
    }

    // 🔍 Call Cashfree (MANDATORY in production)
    try {
      const validation = await validateBank({
        name: member.name,
        bankAccount,
        ifsc,
      });

      console.log("🏦 Cashfree Validation Response:", validation);

      // ❌ If Cashfree fails → STOP
      if (validation.status !== "SUCCESS") {
        member.kycStatus = "FAILED";
        member.kycFailReason = validation.message || "Bank verification failed";
        await member.save();

        return res.status(400).json({
          success: false,
          message: "KYC failed",
          reason: member.kycFailReason,
        });
      }

      // ✅ Cashfree SUCCESS → AUTO APPROVE
      member.kycStatus = "APPROVED";
      await member.save();

      // 🚀 Create beneficiary
      setImmediate(() => createBeneficiary(member));

      return res.json({
        success: true,
        message: "KYC approved automatically via Cashfree",
      });
    } catch (cashfreeError) {
      console.error("Cashfree API error:", cashfreeError.message);

      // If Cashfree is down or auth fails, fail the KYC
      member.kycStatus = "FAILED";
      member.kycFailReason = `Cashfree error: ${cashfreeError.message}`;
      await member.save();

      return res.status(500).json({
        success: false,
        message: "KYC validation failed",
        error: "Cashfree service unavailable",
        details: cashfreeError.message
      });
    }
  } catch (err) {
    console.error("Auto KYC error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: err.message
    });
  }
};
