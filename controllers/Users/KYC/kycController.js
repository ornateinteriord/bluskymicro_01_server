const MemberModel = require("../../../models/Users/Member");

// Submit KYC details
exports.submitKYC = async (req, res) => {
  try {
    const {
      ref_no,
      bankAccount,
      ifsc,
      pan,
      aadhar_no,
      address,
      bankName,
      panImage,
      aadhaarImage,
      checkImage,
      passbookImage,
      rationCardImage,
      profileImage,
      upiId
    } = req.body;

    // Find the member by ref_no
    const member = await MemberModel.findOne({ Member_id: ref_no });

    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    // Validate that all required documents are provided
    const missingDocuments = [];
    if (!panImage && !aadhaarImage) missingDocuments.push("PAN / Aadhaar Image");
    if (!profileImage) missingDocuments.push("Profile Image");

    if (missingDocuments.length > 0) {
      return res.status(400).json({
        message: `Missing required fields/documents: ${missingDocuments.join(", ")}`
      });
    }

    // ==================== CASHFREE BANK VERIFICATION ====================
    // Note: Currently commented out - Admin will manually validate bank details
    // Uncomment this section when Cashfree Payout is activated

    /* 
    const axios = require("axios");
    
    try {
      // First, authenticate with Cashfree to get Bearer token
      const authResponse = await axios.post(
        "https://payout-gamma.cashfree.com/payout/v1/authorize",
        {},
        {
          headers: {
            "X-Client-Id": process.env.CI_APP_ID,
            "X-Client-Secret": process.env.CI_SECRET_KEY,
            "Content-Type": "application/json",
          }
        }
      );

      // Log the auth response for debugging
      console.log("Auth Response:", authResponse.data);

      // Extract token from response
      const bearerToken = authResponse.data?.data?.token || authResponse.data?.token;

      if (!bearerToken) {
        console.error("Failed to extract token from auth response:", authResponse.data);
        throw new Error("Failed to get authorization token from Cashfree");
      }

      console.log("Bearer Token:", bearerToken);

      // Validate bank details using GET request with query parameters
      // This is the correct way to validate bank details in Cashfree
      console.log("Making bank validation request with params:", {
        name: member.Name,
        bankAccount: bankAccount,
        ifsc: ifsc
      });

      const validationResponse = await axios.get(
        "https://payout-gamma.cashfree.com/payout/v1/validation/bankDetails",
        {
          params: {
            name: member.Name,
            bankAccount: bankAccount,
            ifsc: ifsc
          },
          headers: {
            "Authorization": `Bearer ${bearerToken}`,
            "Content-Type": "application/json",
          }
        }
      );

      // Log the validation response for debugging
      console.log("Validation Response:", validationResponse.data);

      // Check if bank validation was successful
      if (validationResponse.data.status !== "SUCCESS") {
        return res.status(400).json({
          message: "Bank account verification failed",
          details: validationResponse.data.message || "Invalid bank details provided"
        });
      }

      // Log successful validation
      console.log("Bank account verified successfully for member:", ref_no);
    } catch (validationError) {
      console.error("Bank validation error:", validationError.response?.data || validationError.message);
      return res.status(400).json({
        message: "Bank account verification failed",
        details: validationError.response?.data?.message || "Could not verify bank details with payment provider"
      });
    }
    */

    // ==================== END CASHFREE VERIFICATION ====================

    // Update member with KYC details
    member.account_number = bankAccount;
    member.ifsc_code = ifsc;
    member.Pan_no = pan;
    member.aadharcard_no = aadhar_no;
    member.bank_name = bankName;
    member.address = address;
    member.upi_id = upiId;
    member.kycStatus = "PROCESSING";

    // Update document URLs
    member.panImage = panImage;
    member.aadhaarImage = aadhaarImage;
    member.checkImage = checkImage;
    member.passbookImage = passbookImage;
    member.rationCardImage = rationCardImage;
    member.profile_image = profileImage;

    // Save the updated member
    await member.save();

    res.json({ message: "KYC submitted successfully with verified bank details" });
  } catch (error) {
    console.error("Error submitting KYC:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Approve KYC
exports.approveKYC = async (req, res) => {
  try {
    const { ref_no } = req.body;

    // Find the member by ref_no
    const member = await MemberModel.findOne({ Member_id: ref_no });

    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    // Update KYC status to APPROVED
    member.kycStatus = "APPROVED";
    await member.save();

    // Trigger auto beneficiary creation
    await autoCreateBeneficiary(member);

    res.json({ message: "KYC approved & beneficiary creation initiated" });
  } catch (error) {
    console.error("Error approving KYC:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get KYC submissions (default: PENDING)
// Get KYC submissions (only PROCESSING)
exports.getKycSubmissions = async (req, res) => {
  try {
    const { q, page = 1, limit = 50 } = req.query;

    // Always fetch only PROCESSING KYCs
    const filter = { kycStatus: "PROCESSING" };

    // 🔍 Search filter
    if (q) {
      filter.$or = [
        { Member_id: q },
        { Name: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
        { mobileno: { $regex: q, $options: "i" } }
      ];
    }

    const skip = (Math.max(parseInt(page, 10), 1) - 1) * parseInt(limit, 10);

    const submissions = await MemberModel.find(filter)
      .select("Member_id Name mobileno email account_number ifsc_code bank_name Pan_no kycStatus beneficiaryStatus beneficiaryId address panImage aadhaarImage checkImage passbookImage rationCardImage profile_image createdAt updatedAt")
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10));

    const total = await MemberModel.countDocuments(filter);

    res.json({
      total,
      count: submissions.length,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      data: submissions
    });
  } catch (error) {
    console.error("Error fetching KYC submissions:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};


// Auto create beneficiary in Cashfree
async function autoCreateBeneficiary(user) {
  // If beneficiary is already created, return
  if (user.beneficiaryStatus === "CREATED") return;

  try {
    // Import axios here to avoid issues with module loading
    const axios = require("axios");

    // First, authenticate with Cashfree to get Bearer token
    const authResponse = await axios.post(
      "https://payout-gamma.cashfree.com/payout/v1/authorize"
      ,
      {},
      {
        headers: {
          "x-client-id": process.env.CI_APP_ID,
          "x-client-secret": process.env.CI_SECRET_KEY,
          "Content-Type": "application/json",
        }

      }
    );
    console.log("Cashfree Auth Responseqqqqq:", authResponse.data);

    // Extract token from response - handle both possible response structures
    const bearerToken = authResponse.data?.data?.token || authResponse.data?.token;

    if (!bearerToken) {
      throw new Error(`Failed to extract authorization token from Cashfree. Response: ${JSON.stringify(authResponse.data)}`);
    }

    // Generate beneficiary ID
    const beneficiaryId = `BEN_${user.Member_id}`;

    // Prepare payload for Cashfree API (use `beneId` as required by Cashfree)
    const payload = {
      beneId: beneficiaryId,
      name: user.Name,
      email: user.email,
      phone: user.mobileno,
      bankAccount: user.account_number,
      ifsc: user.ifsc_code,
      address1: user.address || "India"
    };

    // Make API call to Cashfree with Bearer token
    const response = await axios.post(
      "https://payout-gamma.cashfree.com/payout/v1/addBeneficiary"
      ,
      payload,
      {
        headers: {
          "Authorization": `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
        }
      }
    );

    // If successful, update user with beneficiary ID
    if (response.data.status === "SUCCESS") {
      user.beneficiaryId = beneficiaryId;
      user.beneficiaryStatus = "CREATED";
      user.bank_details = "Beneficiary successfully added and updated in Cashfree";
      await user.save();
      console.log(`Beneficiary created successfully for user ${user.Member_id}`);
    } else {
      console.error(`Failed to create beneficiary for user ${user.Member_id}:`, response.data);
      user.bank_details = `Failed to create beneficiary: ${response.data.message || 'Unknown error'}`;
      await user.save();
    }
  } catch (error) {
    console.error(`Error creating beneficiary for user ${user.Member_id}:`, error.response?.data || error.message);
  }
}

// Export the autoCreateBeneficiary function for use in other modules
exports.autoCreateBeneficiary = autoCreateBeneficiary;