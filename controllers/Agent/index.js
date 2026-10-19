const AccountsModel = require("../../models/accounts.model");
const MemberModel = require("../../models/member.model");
const TransactionModel = require("../../models/transaction.model");
const CommissionModel = require("../../models/commission.model");
const AgentModel = require("../../models/agent.model");
const generateTransactionId = require("../../utils/generateTransactionId");
const { processTransactionCommission } = require("../../utils/commissionUtils");

// Get all commission transactions for an agent
const getCommissionTransactions = async (req, res) => {
    try {
        const { agentId } = req.params;

        if (!agentId) {
            return res.status(400).json({
                success: false,
                message: "Agent ID is required"
            });
        }

        // Get agent details for commission_balance
        const agent = await AgentModel.findOne({ agent_id: agentId });
        const commissionBalance = agent ? (agent.commission_balance || 0) : 0;

        // Find all commission transactions where this agent is the beneficiary
        const commissions = await CommissionModel.find({
            beneficiary_id: agentId
        }).sort({ createdAt: -1 });

        // Calculate summary statistics
        const totalEarned = commissions
            .filter(c => c.status === "CREDITED")
            .reduce((sum, c) => sum + c.commission_amount, 0);

        const totalPending = commissions
            .filter(c => c.status === "PENDING")
            .reduce((sum, c) => sum + c.commission_amount, 0);

        const totalWithdrawn = commissions
            .filter(c => c.status === "WITHDRAWN")
            .reduce((sum, c) => sum + c.commission_amount, 0);

        res.status(200).json({
            success: true,
            message: "Commission transactions fetched successfully",
            data: {
                transactions: commissions,
                summary: {
                    totalEarned,
                    totalPending,
                    totalWithdrawn,
                    availableBalance: totalEarned - totalWithdrawn // Calculate from transactions
                }
            }
        });
    } catch (error) {
        console.error("Error fetching commission transactions:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch commission transactions",
            error: error.message
        });
    }
};

// Withdraw commission for an agent
const withdrawCommission = async (req, res) => {
    try {
        const { agentId } = req.params;
        const { amount, bankDetails } = req.body;

        if (!agentId) {
            return res.status(400).json({
                success: false,
                message: "Agent ID is required"
            });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Valid withdrawal amount is required"
            });
        }

        // Get agent details
        const agent = await AgentModel.findOne({ agent_id: agentId });
        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent not found"
            });
        }

        // Use agent's commission_balance for available balance
        const availableBalance = agent.commission_balance || 0;

        if (amount > availableBalance) {
            return res.status(400).json({
                success: false,
                message: `Insufficient balance. Available: ₹${availableBalance.toFixed(2)}`
            });
        }

        // Generate withdrawal commission ID
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 1000);
        const commissionId = `COMM-WD-${timestamp}${random}`;

        // Deduct from agent's commission_balance
        agent.commission_balance = availableBalance - amount;
        await agent.save();

        // Create withdrawal record in commission table
        const withdrawalRecord = new CommissionModel({
            commission_id: commissionId,
            beneficiary_id: agentId,
            beneficiary_name: agent.name,
            beneficiary_type: "AGENT",
            source_id: agentId,
            source_name: agent.name,
            source_type: "AGENT",
            transaction_id: `WD-${timestamp}`,
            transaction_date: new Date(),
            account_type: "WITHDRAWAL",
            transaction_amount: amount,
            commission_rate: 0,
            commission_amount: amount,
            level: 0,
            status: "WITHDRAWN",
            credited_at: new Date(),
            notes: bankDetails ? `Withdrawal to bank: ${JSON.stringify(bankDetails)}` : "Commission withdrawal"
        });

        await withdrawalRecord.save();

        res.status(200).json({
            success: true,
            message: "Commission withdrawal initiated successfully",
            data: {
                withdrawal_id: commissionId,
                amount: amount,
                remaining_balance: agent.commission_balance,
                withdrawal_date: withdrawalRecord.transaction_date
            }
        });
    } catch (error) {
        console.error("Error processing commission withdrawal:", error);
        res.status(500).json({
            success: false,
            message: "Failed to process commission withdrawal",
            error: error.message
        });
    }
};

// Get all accounts assigned to a specific agent with member details
const getAssignedAccounts = async (req, res) => {
    try {
        const { agentId } = req.params;

        if (!agentId) {
            return res.status(400).json({
                success: false,
                message: "Agent ID is required"
            });
        }

        // Find all accounts assigned to this agent
        const accounts = await AccountsModel.find({
            assigned_to: agentId
        }).sort({ date_of_opening: -1 });

        // Fetch member details for each account
        const accountsWithMemberDetails = await Promise.all(
            accounts.map(async (account) => {
                const member = await MemberModel.findOne({
                    member_id: account.member_id
                });

                return {
                    date_of_opening: account.date_of_opening,
                    account_no: account.account_no,
                    account_holder: member ? member.name : "N/A",
                    date_of_maturity: account.date_of_maturity,
                    balance: account.account_amount,
                    status: account.status,
                    // Include additional fields that might be useful
                    account_id: account.account_id,
                    member_id: account.member_id,
                    account_type: account.account_type,
                    account_operation: account.account_operation
                };
            })
        );

        res.status(200).json({
            success: true,
            message: "Assigned accounts fetched successfully",
            data: accountsWithMemberDetails
        });
    } catch (error) {
        console.error("Error fetching assigned accounts:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch assigned accounts",
            error: error.message
        });
    }
};

// Collect payment for an assigned account
const collectPayment = async (req, res) => {
    try {
        const { accountId, amount } = req.body;
        const agentId = req.params.agentId; // Get agent ID from authenticated user

        // Validate input
        if (!accountId || !amount) {
            return res.status(400).json({
                success: false,
                message: "Account ID and amount are required"
            });
        }

        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Amount must be greater than zero"
            });
        }

        // Find the account
        const account = await AccountsModel.findOne({ account_id: accountId });

        if (!account) {
            return res.status(404).json({
                success: false,
                message: "Account not found"
            });
        }

        // Verify the account is assigned to this agent
        if (account.assigned_to !== agentId) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to collect payments for this account"
            });
        }

        // Check if account is active
        if (account.status !== 'active') {
            return res.status(400).json({
                success: false,
                message: "Cannot collect payment for inactive account"
            });
        }

        // Get member details for transaction
        const member = await MemberModel.findOne({ member_id: account.member_id });

        if (!member) {
            return res.status(404).json({
                success: false,
                message: "Member not found"
            });
        }

        // Generate transaction ID
        const newTransactionId = await generateTransactionId();

        // Update account balance
        account.account_amount += parseFloat(amount);
        await account.save();

        // Create transaction record
        const transaction = await TransactionModel.create({
            transaction_id: newTransactionId,
            transaction_date: new Date(),
            member_id: account.member_id,
            account_number: account.account_no,
            account_type: account.account_type,
            transaction_type: "Collection",
            description: "Collected by agent",
            credit: parseFloat(amount),
            balance: account.account_amount,
            Name: member.name,
            mobileno: member.contactno,
            status: "Completed",
            collected_by: agentId
        });

        // Process commission for introducers (Disabled: Banking / Pigmy deposit commission not in use)
        /*
        try {
            console.log("💰 Processing commission for agent collection...");
            const commissionResult = await processTransactionCommission(transaction);
            console.log("💰 Commission processing result:", commissionResult);
        } catch (commissionError) {
            console.error("❌ Commission processing error:", commissionError.message);
            // Don't fail the collection if commission fails
        }
        */

        res.status(200).json({
            success: true,
            message: "Payment collected successfully",
            data: {
                transaction_id: transaction.transaction_id,
                account_no: account.account_no,
                account_holder: member.name,
                collected_amount: amount,
                new_balance: account.account_amount,
                collection_date: transaction.transaction_date
            }
        });

    } catch (error) {
        console.error("Error collecting payment:", error);
        res.status(500).json({
            success: false,
            message: "Failed to collect payment",
            error: error.message
        });
    }
};

// Make payment (debit) for an assigned account - by agent
const makePayment = async (req, res) => {
    try {
        const { accountId, amount, description } = req.body;
        const agentId = req.params.agentId;

        // Validate input
        if (!accountId || !amount) {
            return res.status(400).json({
                success: false,
                message: "Account ID and amount are required"
            });
        }

        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Amount must be greater than zero"
            });
        }

        // Find the account
        const account = await AccountsModel.findOne({ account_id: accountId });

        if (!account) {
            return res.status(404).json({
                success: false,
                message: "Account not found"
            });
        }

        // Verify the account is assigned to this agent
        if (account.assigned_to !== agentId) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to make payments for this account"
            });
        }

        // Check if account is active
        if (account.status !== 'active') {
            return res.status(400).json({
                success: false,
                message: "Cannot make payment for inactive account"
            });
        }

        // Check if account has sufficient balance
        if (account.account_amount < amount) {
            return res.status(400).json({
                success: false,
                message: `Insufficient balance. Available: ₹${account.account_amount}`
            });
        }

        // Get member details
        const member = await MemberModel.findOne({ member_id: account.member_id });

        if (!member) {
            return res.status(404).json({
                success: false,
                message: "Member not found"
            });
        }

        // Generate transaction ID
        const newTransactionId = await generateTransactionId();

        // Update account balance (debit)
        account.account_amount -= parseFloat(amount);
        await account.save();

        // Create transaction record with paid_by
        const transaction = await TransactionModel.create({
            transaction_id: newTransactionId,
            transaction_date: new Date(),
            member_id: account.member_id,
            account_number: account.account_no,
            account_type: account.account_type,
            transaction_type: "Payment",
            description: description || "Paid by agent",
            credit: 0,
            debit: parseFloat(amount),
            balance: account.account_amount,
            Name: member.name,
            mobileno: member.contactno,
            status: "Completed",
            paid_by: agentId
        });

        res.status(200).json({
            success: true,
            message: "Payment made successfully",
            data: {
                transaction_id: transaction.transaction_id,
                account_no: account.account_no,
                account_holder: member.name,
                paid_amount: amount,
                new_balance: account.account_amount,
                payment_date: transaction.transaction_date
            }
        });

    } catch (error) {
        console.error("Error making payment:", error);
        res.status(500).json({
            success: false,
            message: "Failed to make payment",
            error: error.message
        });
    }
};

// Get all collection transactions for an agent
const getCollectionTransactions = async (req, res) => {
    try {
        const { agentId } = req.params;

        if (!agentId) {
            return res.status(400).json({
                success: false,
                message: "Agent ID is required"
            });
        }

        // Find all transactions collected by this agent (credits)
        const collectedTransactions = await TransactionModel.find({
            collected_by: agentId,
            status: "Completed"
        })
            .sort({ createdAt: -1 })
            .select('transaction_id transaction_date account_number Name credit debit balance status description collected_by paid_by');

        // Find all transactions paid by this agent (debits)
        const paidTransactions = await TransactionModel.find({
            paid_by: agentId,
            status: "Completed"
        })
            .sort({ createdAt: -1 })
            .select('transaction_id transaction_date account_number Name credit debit balance status description collected_by paid_by');

        // Calculate summary
        const totalCollected = collectedTransactions.reduce((sum, t) => sum + (t.credit || 0), 0);
        const totalPaid = paidTransactions.reduce((sum, t) => sum + (t.debit || 0), 0);
        const netCollectedAmount = totalCollected - totalPaid;

        // Combine and sort by date
        const allTransactions = [...collectedTransactions, ...paidTransactions]
            .sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));

        res.status(200).json({
            success: true,
            message: "Collection transactions fetched successfully",
            data: {
                transactions: allTransactions,
                summary: {
                    totalCollected,
                    totalPaid,
                    netCollectedAmount
                }
            }
        });
    } catch (error) {
        console.error("Error fetching collection transactions:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch collection transactions",
            error: error.message
        });
    }
};

module.exports = {
    getAssignedAccounts,
    collectPayment,
    makePayment,
    getCollectionTransactions,
    getCommissionTransactions,
    withdrawCommission
};
