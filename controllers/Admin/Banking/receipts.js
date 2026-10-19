const mongoose = require("mongoose");
const ReceiptsModel = require("../../../models/receipts.model.js");
const AccountsModel = require("../../../models/accounts.model.js");
const TransactionModel = require("../../../models/transaction.model.js");
const generateTransactionId = require("../../../utils/generateTransactionId.js");
const { processTransactionCommission } = require("../../../utils/commissionUtils");

// Create a new receipt
const createReceipt = async (req, res) => {
    try {
        const {
            receipt_date,
            received_from,
            receipt_details,
            mode_of_payment_received,
            amount,
            status,
            ref_no,
            receipt_no,
            entered_by,
            branch_code,
            member_id,
            account_details
        } = req.body;

        // Auto-increment receipt_id with RPT prefix
        const lastReceipt = await ReceiptsModel.findOne()
            .sort({ receipt_id: -1 })
            .limit(1);

        let newReceiptId = "RPT0001"; // Default starting ID
        if (lastReceipt && lastReceipt.receipt_id) {
            // Extract numeric part from format "RPTXXXX" and increment
            const numericPart = lastReceipt.receipt_id.replace(/^RPT/, '');
            const lastId = parseInt(numericPart);
            if (!isNaN(lastId)) {
                const nextId = lastId + 1;
                // Format with RPT prefix and pad to 4 digits
                newReceiptId = `RPT${nextId.toString().padStart(4, '0')}`;
            }
        }

        // Create new receipt with auto-generated receipt_id
        const newReceipt = await ReceiptsModel.create({
            receipt_id: newReceiptId,
            receipt_date,
            received_from,
            receipt_details,
            mode_of_payment_received,
            amount,
            status: status || "active",
            ref_no,
            receipt_no,
            entered_by,
            branch_code,
            member_id,
            account_details
        });

        // If account_details is provided, update account balance and create transaction
        if (account_details && account_details.account_id && amount > 0) {
            console.log(`📥 Receipt: Processing account update for account_id: ${account_details.account_id}, amount: ${amount}`);

            // First, check if account exists and handle null account_amount
            // The frontend sends _id as account_id, so we check both
            const existingAccount = await AccountsModel.findOne({ 
                $or: [
    { _id: mongoose.Types.ObjectId.isValid(account_details.account_id) ? account_details.account_id : null },
    { account_id: account_details.account_id }
].filter(Boolean)
            });

if (!existingAccount) {
    console.log(`❌ Account not found: ${account_details.account_id}`);
    return res.status(400).json({
        success: false,
        message: `Account not found: ${account_details.account_id}`
    });
} else {
    console.log(`📊 Existing account balance: ${existingAccount.account_amount}`);

    // If account_amount is null, set it to 0 first
    if (existingAccount.account_amount === null || existingAccount.account_amount === undefined) {
        await AccountsModel.updateOne(
            { _id: existingAccount._id },
            { $set: { account_amount: 0 } }
        );
        console.log(`🔧 Initialized null account_amount to 0`);
    }

    // Update account balance - ADD money for receipt
    const account = await AccountsModel.findOneAndUpdate(
        { _id: existingAccount._id },
        { $inc: { account_amount: amount } },
        { new: true }
    );

    if (account) {
        console.log(`✅ Account updated. New balance: ${account.account_amount}`);

        // Generate unique transaction ID using utility
        const transId = await generateTransactionId();
        console.log(`🔑 Generated transaction ID: ${transId}`);

        // Create transaction record
        const transaction = await TransactionModel.create({
            transaction_id: transId,
            transaction_date: receipt_date || new Date(),
            member_id: member_id,
            account_number: account_details.account_no,
            account_type: account_details.account_type,
            transaction_type: "Receipt",
            description: receipt_details || `Receipt - ${newReceiptId}`,
            credit: amount,
            debit: 0,
            balance: account.account_amount,
            Name: received_from,
            status: "Completed",
            reference_no: newReceiptId,
            collected_by: entered_by
        });

        // Process commission for introducers (Disabled: Banking / Pigmy deposit commission not in use)
        /*
        try {
            console.log("💰 Processing commission for admin receipt...");
            const commissionResult = await processTransactionCommission(transaction);
            console.log("💰 Commission processing result:", commissionResult);
        } catch (commissionError) {
            console.error("❌ Commission processing error:", commissionError.message);
            // Don't fail the receipt if commission fails
        }
        */

        console.log(`📝 Transaction created: ${transaction.transaction_id}`);
    } else {
        console.log(`❌ Failed to update account balance`);
    }
}
        } else {
    console.log(`ℹ️ Receipt: No account update needed. account_details: ${JSON.stringify(account_details)}, amount: ${amount}`);
}

res.status(201).json({
    success: true,
    message: "Receipt created successfully",
    data: newReceipt
});
    } catch (error) {
    console.error("Error creating receipt:", error);
    res.status(500).json({
        success: false,
        message: "Failed to create receipt",
        error: error.message
    });
}
};

// Get all receipts with pagination and filtering
const getReceipts = async (req, res) => {
    try {
        const { page = 1, limit = 10, search, status, branch_code } = req.query;

        // Build filter object - exclude inactive records by default
        const filter = { status: { $ne: 'inactive' } };
        if (status) {
            filter.status = status;
        }
        if (branch_code) {
            filter.branch_code = branch_code;
        }
        if (search) {
            filter.$or = [
                { receipt_id: { $regex: search, $options: "i" } },
                { receipt_details: { $regex: search, $options: "i" } },
                { received_from: { $regex: search, $options: "i" } },
                { member_id: { $regex: search, $options: "i" } },
                { "account_details.account_no": { $regex: search, $options: "i" } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const receipts = await ReceiptsModel.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const totalReceipts = await ReceiptsModel.countDocuments(filter);

        res.status(200).json({
            success: true,
            message: "Receipts fetched successfully",
            data: receipts,
            pagination: {
                total: totalReceipts,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(totalReceipts / parseInt(limit))
            }
        });
    } catch (error) {
        console.error("Error fetching receipts:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch receipts",
            error: error.message
        });
    }
};

// Get a single receipt by ID
const getReceiptById = async (req, res) => {
    try {
        const { receiptId } = req.params;

        // Exclude inactive records
        const allReceipts = await ReceiptsModel.find({ status: { $ne: 'inactive' } });
        const receipt = allReceipts.find(r => r.receipt_id === receiptId);

        if (!receipt) {
            return res.status(404).json({
                success: false,
                message: "Receipt not found"
            });
        }

        res.status(200).json({
            success: true,
            message: "Receipt fetched successfully",
            data: receipt
        });
    } catch (error) {
        console.error("Error fetching receipt:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch receipt",
            error: error.message
        });
    }
};

// Update a receipt by ID
const updateReceipt = async (req, res) => {
    try {
        const { receiptId } = req.params;
        const updateData = req.body;

        // Find receipt by receipt_id
        const receipt = await ReceiptsModel.findOne({ receipt_id: receiptId });
        if (!receipt) {
            return res.status(404).json({
                success: false,
                message: "Receipt not found"
            });
        }

        // Update the receipt
        const updatedReceipt = await ReceiptsModel.findOneAndUpdate(
            { receipt_id: receiptId },
            { $set: updateData },
            { new: true, runValidators: true }
        );

        res.status(200).json({
            success: true,
            message: "Receipt updated successfully",
            data: updatedReceipt
        });
    } catch (error) {
        console.error("Error updating receipt:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update receipt",
            error: error.message
        });
    }
};

// Delete a receipt by ID (soft delete - update status to inactive)
const deleteReceipt = async (req, res) => {
    try {
        const { receiptId } = req.params;

        const receipt = await ReceiptsModel.findOne({ receipt_id: receiptId });
        if (!receipt) {
            return res.status(404).json({
                success: false,
                message: "Receipt not found"
            });
        }

        // Soft delete by updating status
        const deletedReceipt = await ReceiptsModel.findOneAndUpdate(
            { receipt_id: receiptId },
            { $set: { status: "inactive" } },
            { new: true }
        );

        res.status(200).json({
            success: true,
            message: "Receipt deleted successfully",
            data: deletedReceipt
        });
    } catch (error) {
        console.error("Error deleting receipt:", error);
        res.status(500).json({
            success: false,
            message: "Failed to delete receipt",
            error: error.message
        });
    }
};

module.exports = {
    createReceipt,
    getReceipts,
    getReceiptById,
    updateReceipt,
    deleteReceipt
};
