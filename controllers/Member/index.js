const AccountsModel = require("../../models/accounts.model");
const MemberModel = require("../../models/member.model");

// Get logged-in member's account summary
const getMyAccounts = async (req, res) => {
    try {
        // Get member_id from authenticated user
        const memberId = req.user.memberId || req.user.userId;

        if (!memberId) {
            return res.status(400).json({
                success: false,
                message: "Member ID not found in token"
            });
        }

        // Get all accounts for this member with account group information
        const accounts = await AccountsModel.aggregate([
            {
                $match: {
                    $or: [
        { member_id: memberId },           // String comparison
        { member_id: parseInt(memberId) }   // Number comparison
    ]
}
            },
{
                $lookup: {
        from: "account_group_tbl",
            localField: "account_type",
                foreignField: "account_group_id",
                    as: "groupInfo"
    }
},
{
                $unwind: {
        path: "$groupInfo",
            preserveNullAndEmptyArrays: true
    }
},
{
                $group: {
        _id: "$account_type",
            account_group_name: { $first: "$groupInfo.account_group_name" },
        count: { $sum: 1 },
        accounts: {
                        $push: {
                account_id: "$account_id",
                    member_id: "$member_id",
                        account_no: "$account_no",
                            account_type: "$account_type",
                                account_amount: "$account_amount",
                                    status: "$status",
                                        date_of_opening: "$date_of_opening"
            }
        }
    }
},
{
                $project: {
        _id: 0,
            account_type: "$_id",
                account_group_name: 1,
                    count: 1,
                        accounts: 1
    }
},
{
                $sort: { account_type: 1 }
}
        ]);

// Calculate total balance across all accounts
const totalBalance = accounts.reduce((sum, accountType) => {
    // Sum all account_amount values in this account type
    const typeBalance = accountType.accounts.reduce((typeSum, account) => {
        return typeSum + (account.account_amount || 0);
    }, 0);
    return sum + typeBalance;
}, 0);

res.status(200).json({
    success: true,
    message: "Member accounts fetched successfully",
    data: {
        accountTypes: accounts,
        totalAccounts: accounts.reduce((sum, acc) => sum + acc.count, 0),
        totalBalance: totalBalance
    }
});
    } catch (error) {
    console.error("Error fetching member accounts:", error);
    res.status(500).json({
        success: false,
        message: "Failed to fetch member accounts",
        error: error.message
    });
}
};

// Update logged-in member's profile
const updateMyProfile = async (req, res) => {
    try {
        const memberId = req.params.memberId;
        const updateData = req.body;

        // Validate that the logged-in user is updating their own profile
        const loggedInMemberId = req.user.memberId || req.user.userId;
        if (memberId !== loggedInMemberId) {
            return res.status(403).json({
                success: false,
                message: "You can only update your own profile"
            });
        }

        // Remove fields that shouldn't be updated by user
        delete updateData.member_id;
        delete updateData.emailid;  // Email cannot be changed
        delete updateData.contactno; // Contact cannot be changed
        delete updateData.branch_id;
        delete updateData.date_of_joining;
        delete updateData.receipt_no;
        delete updateData.entered_by;
        delete updateData.status;
        delete updateData.introducer;
        delete updateData.introducer_name;
        delete updateData._id;
        delete updateData.createdAt;
        delete updateData.updatedAt;

        // Find and update the member (Checking both lowercase and uppercase fields)
        const updatedMember = await MemberModel.findOneAndUpdate(
            { 
                $or: [
    { member_id: memberId },
    { Member_id: memberId }
]
            },
{ $set: updateData },
{ new: true, runValidators: true }
        );

if (!updatedMember) {
    return res.status(404).json({
        success: false,
        message: "Member not found"
    });
}

res.status(200).json({
    success: true,
    message: "Profile updated successfully",
    data: updatedMember
});
    } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({
        success: false,
        message: "Failed to update profile",
        error: error.message
    });
}
};

// Get member basic info (for recipient lookup during transfer)
const getMemberBasicInfo = async (req, res) => {
    try {
        const { memberId } = req.params;

        const member = await MemberModel.findOne({
            $or: [
    { member_id: memberId },
    { Member_id: memberId }
]
        });

if (!member) {
    return res.status(404).json({
        success: false,
        message: "Member not found"
    });
}

const userRole = req.user?.role;
const isAdmin = userRole === "ADMIN" || userRole === "ADMIN_01";

if (member.status !== "active" && !isAdmin) {
    return res.status(403).json({
        success: false,
        message: "Member account is not active"
    });
}

res.status(200).json({
    success: true,
    message: "Member info fetched successfully",
    data: {
        member_id: member.member_id || member.Member_id,
        name: member.name || member.Name,
        contactno: member.contactno || member.mobileno,
        emailid: member.emailid || member.email
    }
});
    } catch (error) {
    console.error("Error fetching member info:", error);
    res.status(500).json({
        success: false,
        message: "Failed to fetch member info",
        error: error.message
    });
}
};

// Get member's accounts (without balance - for recipient account selection)
const getMemberAccountsPublic = async (req, res) => {
    try {
        const { memberId } = req.params;

        // Verify member exists and is active
        const member = await MemberModel.findOne({
            $or: [
    { member_id: memberId },
    { Member_id: memberId }
]
        });

if (!member) {
    return res.status(404).json({
        success: false,
        message: "Member not found"
    });
}

const userRole = req.user?.role;
const isAdmin = userRole === "ADMIN" || userRole === "ADMIN_01";

if (member.status !== "active" && !isAdmin) {
    return res.status(403).json({
        success: false,
        message: "Member account is not active"
    });
}

// Get accounts with account group names but WITHOUT balances
// Handle both string and number types for member_id
const accounts = await AccountsModel.aggregate([
    {
                $match: {
                    $or: [
        { member_id: memberId },           // String comparison
        { member_id: parseInt(memberId) }   // Number comparison
    ],
        status: isAdmin ? { $in: ["active", "pending"] } : "active"
}
            },
{
                $lookup: {
        from: "account_group_tbl",
            localField: "account_type",
                foreignField: "account_group_id",
                    as: "groupInfo"
    }
},
{
                $unwind: {
        path: "$groupInfo",
            preserveNullAndEmptyArrays: true
    }
},
{
                $project: {
        _id: 1,
            account_id: 1,
                account_no: 1,
                    account_type: 1,
                        account_group_name: "$groupInfo.account_group_name",
                            date_of_opening: 1,
                                account_amount: 1,
                                    status: 1
    }
},
{
                $sort: { date_of_opening: -1 }
}
        ]);

res.status(200).json({
    success: true,
    message: "Member accounts fetched successfully",
    data: accounts
});
    } catch (error) {
    console.error("Error fetching member accounts:", error);
    res.status(500).json({
        success: false,
        message: "Failed to fetch member accounts",
        error: error.message
    });
}
};

// Get member transactions with optional account_type filter
const getMemberTransactions = async (req, res) => {
    try {
        const { memberId } = req.params;
        const { account_type } = req.query;

        if (!memberId) {
            return res.status(400).json({
                success: false,
                message: "Member ID is required"
            });
        }

        // Build query filter
        const filter = { member_id: memberId };
        if (account_type) {
            filter.account_type = account_type;
        }

        // Find all transactions for this member (optionally filtered by account type)
        const TransactionModel = require("../../models/transaction.model");
        const transactions = await TransactionModel.find(filter)
            .sort({ transaction_date: -1 })
            .select('transaction_id transaction_date account_number account_type transaction_type description credit debit balance status reference_no');

        res.status(200).json({
            success: true,
            message: "Member transactions fetched successfully",
            data: transactions
        });
    } catch (error) {
        console.error("Error fetching member transactions:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch member transactions",
            error: error.message
        });
    }
};

// Get all active account groups
const getMemberAccountGroups = async (req, res) => {
    try {
        const AccountGroupModel = require("../../models/accountGroup.model");
        const accountGroups = await AccountGroupModel.find({ status: "active" })
            .sort({ account_group_name: 1 });

        res.status(200).json({
            success: true,
            message: "Account groups fetched successfully",
            data: accountGroups
        });
    } catch (error) {
        console.error("Error fetching account groups:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch account groups",
            error: error.message
        });
    }
};

// Get interests by account group
const getMemberInterestsByAccountGroup = async (req, res) => {
    try {
        const { account_group_id } = req.params;
        const InterestModel = require("../../models/interest.model");

        const AccountGroupModel = require("../../models/accountGroup.model");
        const accountGroup = await AccountGroupModel.findOne({
            account_group_id: account_group_id
        });

        if (!accountGroup) {
            return res.status(404).json({
                success: false,
                message: "Account group not found"
            });
        }

        const planTypeMapping = {
            "FIXED DEPOSIT": "FD",
            "FD": "FD",
            "RECURRING DEPOSIT": "RD",
            "RD": "RD",
            "PIGMY": "PIGMY",
            "PIGMY DEPOSIT": "PIGMY",
            "SAVING": "SAVING",
            "SAVINGS": "SAVING",
            "SAVINGS BANK": "SAVING",
            "SB": "SAVING",
            "CURRENT": "CURRENT",
            "CURRENT ACCOUNT": "CURRENT",
            "CA": "CURRENT",
            "PIGMY SAVING": "PIGMY SAVING",
            "PIGMY LOAN": "PIGMY LOAN",
            "PIGMY GOLD LOAN": "PIGMY GOLD LOAN"
        };

        const groupNameUpper = accountGroup.account_group_name?.toUpperCase() || "";
        let planType = planTypeMapping[groupNameUpper];

        console.log(`[MemberInterests] Group: ${groupNameUpper}, Mapped PlanType: ${planType}`);

        // If no direct mapping, try partial matches
        if (!planType) {
            if (groupNameUpper.includes("FIXED")) planType = "FD";
            else if (groupNameUpper.includes("RECURRING")) planType = "RD";
            else if (groupNameUpper.includes("SAVING")) planType = "SAVING";
            else if (groupNameUpper.includes("CURRENT")) planType = "CURRENT";
            else if (groupNameUpper.includes("PIGMY")) planType = "PIGMY";
            else planType = groupNameUpper;
            console.log(`[MemberInterests] Fallback PlanType: ${planType}`);
        }

        // For SB (SAVING) and CA (CURRENT), we don't allow interest rates as per user request
        if (planType === "SAVING" || planType === "CURRENT") {
            return res.status(200).json({
                success: true,
                message: `No interest plans for ${planType} accounts`,
                data: []
            });
        }

        const interests = await InterestModel.find({
            $or: [
    { plan_type: planType },
    { ref_id: account_group_id } // Also support direct ID matching
],
    status: { $regex: /^active$/i }
        }).sort({ createdAt: -1 });

console.log(`[MemberInterests] Found ${interests.length} interests for ${planType}`);

res.status(200).json({
    success: true,
    message: "Interests fetched successfully",
    data: interests
});
    } catch (error) {
    console.error("Error fetching interests:", error);
    res.status(500).json({
        success: false,
        message: "Failed to fetch interests",
        error: error.message
    });
}
};

// Create a new member account (Self-Service)
const createMemberAccount = async (req, res) => {
    try {
        const {
            account_type, // This is account_group_id
            account_operation,
            interest_rate,
            duration,
            date_of_maturity,
            account_amount
        } = req.body;

        // Get member_id from authenticated user
        const memberId = req.user.memberId || req.user.userId;

        if (!memberId) {
            return res.status(400).json({
                success: false,
                message: "Member ID not found in token"
            });
        }

        if (!account_type) {
            return res.status(400).json({
                success: false,
                message: "Account Type is required"
            });
        }

        const AccountGroupModel = require("../../models/accountGroup.model");

        // Get the account group to determine the prefix for account_no
        const accountGroup = await AccountGroupModel.findOne({
            account_group_id: account_type
        });

        if (!accountGroup) {
            return res.status(404).json({
                success: false,
                message: "Account type not found"
            });
        }

        // Check if member already has an account of this type (active or pending)
        const existingAccount = await AccountsModel.findOne({
            member_id: memberId,
            account_type: account_type,
            status: { $nin: ["closed", "inactive"] }
        });

        if (existingAccount) {
            return res.status(409).json({
                success: false,
                message: `You already have an active ${accountGroup.account_group_name} account (${existingAccount.account_no || existingAccount.account_id}).`
            });
        }

        // --- ACCOUNT ID & NUMBER GENERATION (Same as Admin) ---

        // Auto-increment account_id with ACC prefix
        const lastAccount = await AccountsModel.findOne()
            .sort({ account_id: -1 })
            .limit(1);

        let newAccountId = "ACC000001";
        if (lastAccount && lastAccount.account_id) {
            const numericPart = lastAccount.account_id.replace(/^ACC/, '');
            const lastId = parseInt(numericPart);
            if (!isNaN(lastId)) {
                const nextId = lastId + 1;
                newAccountId = `ACC${nextId.toString().padStart(6, '0')}`;
            }
        }

        // Professional Account Number Generation
        // Format: [PREFIX][SEQUENCE]
        // Example: SB000001, RD000001, PIG000001

        const groupName = accountGroup.account_group_name?.toUpperCase() || "";
        let typePrefix = "ACC";
        if (groupName.includes("SAVING") || groupName === "SB") typePrefix = "SB";
        else if (groupName.includes("CURRENT") || groupName === "CA" || groupName === "CUR") typePrefix = "CA";
        else if (groupName.includes("RECURRING") || groupName === "RD") typePrefix = "RD";
        else if (groupName.includes("FIXED") || groupName === "FD") typePrefix = "FD";
        else if (groupName.includes("PIGMY") || groupName === "PIG") typePrefix = "PIG";
        else if (groupName.includes("MONTHLY") || groupName === "MIS") typePrefix = "MI";
        else if (groupName.includes("DAILY")) typePrefix = "PIG";

        // Find the last account with this prefix to determine next sequence
        const lastAccountWithPrefix = await AccountsModel.findOne({
            account_no: { $regex: new RegExp(`^${typePrefix}`) }
        }).sort({ account_no: -1 }).limit(1);

        let newAccountNo;
        if (lastAccountWithPrefix && lastAccountWithPrefix.account_no) {
            // Extract the sequence part (everything after prefix)
            const sequencePart = lastAccountWithPrefix.account_no.substring(typePrefix.length);
            const lastSeq = parseInt(sequencePart);
            if (!isNaN(lastSeq)) {
                newAccountNo = `${typePrefix}${(lastSeq + 1).toString().padStart(6, '0')}`;
            } else {
                newAccountNo = `${typePrefix}000001`;
            }
        } else {
            newAccountNo = `${typePrefix}000001`;
        }

        // Create new account
        const newAccount = await AccountsModel.create({
            account_id: newAccountId,
            // branch_id: "Main", // Default or fetch from member
            date_of_opening: new Date(),
            member_id: memberId,
            account_type,
            account_no: newAccountNo,
            account_operation: account_operation || "Single",
            // introducer: null, // Member self-service often doesn't specify introducer directly here, or it comes from Member profile
            entered_by: memberId, // Created by self
            // ref_id,
            interest_rate: (groupName.includes("SAVING") || groupName === "SB" || groupName.includes("CURRENT") || groupName === "CA") ? 0 : (interest_rate || 0),
            duration: duration || 0,
            date_of_maturity: date_of_maturity,
            date_of_close: null,
            status: "active", // Or pending approval? user didn't specify, assuming active for now
            // assigned_to: null,
            account_amount: account_amount || 0,
            // joint_member: null
        });

        // Fetch member to get introducer for commission
        const member = await MemberModel.findOne({ member_id: memberId });
        // Update account with member's introducer if needed, or leave it for commission calculation

        // If account is created with initial amount > 0, create transaction and trigger commission
        if (account_amount && account_amount > 0) {
            try {
                const TransactionModel = require("../../models/transaction.model");
                const generateTransactionId = require("../../utils/generateTransactionId");
                const { processTransactionCommission } = require("../../utils/commissionUtils");

                // Generate transaction ID
                const transId = await generateTransactionId();

                // Create transaction record for initial deposit
                const transaction = await TransactionModel.create({
                    transaction_id: transId,
                    transaction_date: new Date(),
                    member_id: memberId,
                    account_number: newAccountNo,
                    account_type: account_type,
                    transaction_type: "Account Opening",
                    description: `Initial deposit - Account ${newAccountNo}`,
                    credit: account_amount,
                    debit: 0,
                    balance: account_amount,
                    Name: member ? member.name : null,
                    mobileno: member ? member.contactno : null,
                    status: "Completed",
                    collected_by: memberId // Self
                });

                console.log(`📝 Transaction created for self-service account opening: ${transId}`);

                // Process commission for introducers
                console.log("💰 Processing commission for account opening deposit...");
                const commissionResult = await processTransactionCommission(transaction);
                console.log("💰 Commission processing result:", commissionResult);
            } catch (txError) {
                console.error("❌ Error creating transaction/commission for account opening:", txError.message);
                // Don't fail account creation if transaction/commission fails
            }
        }

        res.status(201).json({
            success: true,
            message: "Account created successfully",
            data: newAccount
        });

    } catch (error) {
        console.error("Error creating member account:", error);
        res.status(500).json({
            success: false,
            message: "Failed to create account",
            error: error.message
        });
    }
};

module.exports = {
    getMyAccounts,
    updateMyProfile,
    getMemberBasicInfo,
    getMemberAccountsPublic,
    getMemberTransactions,
    getMemberAccountGroups,
    getMemberInterestsByAccountGroup,
    createMemberAccount
};
