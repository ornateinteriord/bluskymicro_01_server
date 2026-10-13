const TransactionModel = require("../models/Transaction/Transaction");
const NidhiTransactionModel = require("../models/transaction.model");

/**
 * Generate a unique transaction ID using timestamp and high entropy
 * Format: {prefix}_{timestamp}_{random}
 */
const generateTransactionId = async (prefix = "TXN") => {
    let attempts = 0;
    while (attempts < 5) {
        const timestamp = Date.now();
        const random = Math.floor(100000 + Math.random() * 900000);
        const newTransactionId = `${prefix}_${timestamp}_${random}`;

        // Verify it doesn't exist in either model
        const [existing1, existing2] = await Promise.all([
            TransactionModel.findOne({ transaction_id: newTransactionId }),
            NidhiTransactionModel.findOne({ transaction_id: newTransactionId })
        ]);

        if (!existing1 && !existing2) {
            return newTransactionId;
        }
        attempts++;
    }

    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
};

module.exports = generateTransactionId;
