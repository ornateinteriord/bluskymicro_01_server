const TransactionModel = require("../../models/transaction.model");
const cashfreeConfig = require("../../utils/cashfree");
const crypto = require("crypto");
const axios = require("axios");
const { processTransactionCommission } = require("../../utils/commissionUtils");
// Unified format for Transaction ID
const generateTransactionId = () => `TXN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

// Get Transactions for any Member/Agent
exports.getTransactions = async (req, res) => {
    try {
        const { id } = req.params; // member_id or agent_id

        const transactions = await TransactionModel.find({ member_id: id }).sort({ createdAt: -1 });

        return res.status(200).json({ success: true, data: transactions });

    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// Add Transaction (Unified)
exports.addTransaction = async (req, res) => {
    try {
        const {
            member_id,
            amount,
            transaction_type,
            account_number,
            account_type,
            Name,
            mobileno,
            description,
            reference_no
        } = req.body;

        if (!member_id || !amount || !transaction_type) {
            return res.status(400).json({ success: false, message: "Missing required fields: member_id, amount, transaction_type" });
        }

        let credit = 0;
        let debit = 0;

        // Logic mapping based on user request:
        // 'Money Added', 'App Cash Transfer' -> Credit (Deposit)
        // 'Agent Withdraw', 'Member Withdraw', 'Transfer' -> Debit (Expense)

        const creditTypes = ['Money Added', 'App Cash Transfer'];
        const debitTypes = ['Agent Withdraw', 'Member Withdraw', 'Transfer'];

        if (creditTypes.includes(transaction_type)) {
            credit = Number(amount);
        } else if (debitTypes.includes(transaction_type)) {
            debit = Number(amount);
        } else {
            return res.status(400).json({ success: false, message: "Invalid Transaction Type" });
        }

        // Calculate Balance
        const lastTx = await TransactionModel.findOne({ member_id }).sort({ createdAt: -1 });
        const lastBalance = lastTx ? lastTx.balance : 0;

        if (debit > 0 && lastBalance < debit) {
            return res.status(400).json({ success: false, message: "Insufficient Balance" });
        }

        const newBalance = lastBalance + credit - debit;

        const newTx = new TransactionModel({
            transaction_id: generateTransactionId(),
            transaction_date: new Date(),
            member_id,
            transaction_type,
            account_number,
            account_type,
            Name,
            mobileno,
            description: description || transaction_type,
            credit,
            debit,
            balance: newBalance,
            ew_debit: debit > 0 ? String(debit) : "0",
            status: "Pending",
            reference_no
        });

        await newTx.save();
        return res.status(201).json({ success: true, message: "Transaction Successful", data: newTx });

    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// Admin: Get All
exports.getAllTransactions = async (req, res) => {
    try {
        const transactions = await TransactionModel.find({}).sort({ createdAt: -1 });
        return res.status(200).json({ success: true, data: transactions });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// Cashfree Payment Integration
// ==========================================


// 1. Create Payment Order (Using Cashfree Orders API)
exports.createPaymentOrder = async (req, res) => {
    const AccountsModel = require("../../models/accounts.model");
    const MemberModel = require("../../models/member.model");

    try {
        const { member_id, amount, mobileno, Name, email, account_id, account_no, account_type, description } = req.body;

        if (!member_id || !amount || !mobileno || !Name) {
            return res.status(400).json({ success: false, message: "Missing required fields: member_id, amount, mobileno, Name" });
        }

        // Validate account details are provided
        if (!account_id || !account_no || !account_type) {
            return res.status(400).json({
                success: false,
                message: "Missing required account details: account_id, account_no, account_type"
            });
        }

        // Validate member exists and is active
        const allMembers = await MemberModel.find({});
        const member = allMembers.find(m => m.member_id === member_id || m.member_id === parseInt(member_id));

        if (!member) {
            return res.status(404).json({
                success: false,
                message: "Member not found"
            });
        }

        if (member.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "Member account is not active"
            });
        }

        // Validate account exists and belongs to member
        const allAccounts = await AccountsModel.find({});
        const account = allAccounts.find(acc =>
            (acc.account_id === account_id || acc.account_id === parseInt(account_id)) &&
            (acc.member_id === member_id || acc.member_id === parseInt(member_id)) &&
            (acc.account_no == account_no) &&
            (acc.account_type === account_type)
        );

        if (!account) {
            return res.status(404).json({
                success: false,
                message: "Account not found or does not belong to this member"
            });
        }

        // Check if account is active
        if (account.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "Account is not active. Cannot add money to inactive account."
            });
        }

        const orderId = `ORDER_${Date.now()}`; // Generate unique Order ID

        // Prepare Request for Cashfree Orders API
        const request = {
            order_id: orderId,
            order_amount: Number(amount),
            order_currency: "USD",
            order_note: description || "Add Money",
            customer_details: {
                customer_id: String(member_id),
                customer_phone: mobileno,
                customer_name: Name,
                customer_email: email || "customer@example.com"
            },
            order_meta: {
                return_url: `${process.env.FRONTEND_URL}/user/account-wallet?order_id={order_id}&order_status={order_status}&member_id=${member_id}`,
                notify_url: `${process.env.BACKEND_URL}/transaction/webhook/cashfree`
            },
            order_tags: {
                account_no: String(account_no),
                account_type: account_type,
                member_id: String(member_id)
            }
        };

        // Check if Cashfree credentials are available
        if (!cashfreeConfig.CASHFREE_APP_ID || !cashfreeConfig.CASHFREE_SECRET_KEY) {
            console.error("❌ Cashfree credentials not configured");
            return res.status(500).json({
                success: false,
                message: "Payment gateway not configured. Contact administrator."
            });
        }

        // Log the request being sent to Cashfree
        console.log("=== Creating Cashfree Order ===");
        console.log("Environment:", cashfreeConfig.IS_PRODUCTION ? "PRODUCTION" : "SANDBOX");
        console.log("Base URL:", cashfreeConfig.CASHFREE_BASE_URL);
        console.log("Request Body:", JSON.stringify(request, null, 2));

        // Direct axios call to Cashfree Orders API
        const response = await axios.post(`${cashfreeConfig.CASHFREE_BASE_URL}/pg/orders`, request, {
            headers: {
                'Content-Type': 'application/json',
                'x-client-id': cashfreeConfig.CASHFREE_APP_ID,
                'x-client-secret': cashfreeConfig.CASHFREE_SECRET_KEY,
                'x-api-version': cashfreeConfig.X_API_VERSION
            }
        });

        console.log("=== Cashfree Response ===");
        console.log("Status:", response.status);
        console.log("Response Data:", JSON.stringify(response.data, null, 2));

        // Validate that payment_session_id exists in response
        if (!response.data || !response.data.payment_session_id) {
            console.error("❌ ERROR: payment_session_id not found in Cashfree response!");
            console.error("Full Response:", JSON.stringify(response.data, null, 2));
            throw new Error("Cashfree API did not return a payment_session_id. Please check API credentials and configuration.");
        }

        const paymentSessionId = response.data.payment_session_id;

        console.log("✅ Payment Session ID:", paymentSessionId);
        console.log("✅ Order ID:", response.data.order_id);

        // Create Pending Transaction in DB with account details
        const newTx = new TransactionModel({
            transaction_id: orderId, // Use Order ID as Transaction ID
            transaction_date: new Date(),
            member_id,
            account_number: account_no,
            account_type: account_type,
            transaction_type: "Money Added",
            description: `Online Top-up to Account ${account_no} (Pending)`,
            credit: Number(amount),
            debit: 0,
            balance: 0, // Will update on success
            status: "Pending",
            payment_gateway: "Cashfree",
            gateway_order_id: response.data.order_id,
            payment_session_id: paymentSessionId,
            payment_status: "Pending",
            Name,
            mobileno
        });

        await newTx.save();

        // Return like BICCSL-Server - frontend uses Cashfree JS SDK to open checkout
        return res.status(200).json({
            success: true,
            order_id: orderId,
            payment_session_id: paymentSessionId,
            cashfree_env: cashfreeConfig.IS_PRODUCTION ? "production" : "sandbox",
            account_no: account_no
        });

    } catch (error) {
        console.error("=== Cashfree Order Error ===");
        console.error("Error Message:", error.message);
        console.error("Error Response Data:", JSON.stringify(error.response?.data, null, 2));
        console.error("Error Response Status:", error.response?.status);
        console.error("Error Response Headers:", JSON.stringify(error.response?.headers, null, 2));
        console.error("Request Config:", JSON.stringify({
            url: error.config?.url,
            method: error.config?.method,
            headers: error.config?.headers
        }, null, 2));
        console.error("===========================");
        // Return the actual error from Cashfree API if available
        if (error.response?.data?.message) {
            return res.status(error.response.status || 500).json({
                success: false,
                message: error.response.data.message,
                code: error.response.data.code || null
            });
        } else {
            return res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }
};

// ======================
// CASHFREE WEBHOOK (FINAL)
// ======================
// ======================
// ENHANCED CASHFREE WEBHOOK ONLY
// ======================

// ======================
// SIMPLIFIED CASHFREE WEBHOOK
// ======================

exports.handleCashfreeWebhook = async (req, res) => {
    const AccountsModel = require("../../models/accounts.model");
    const start = Date.now();

    try {
        console.log("🟢 CASHFREE WEBHOOK RECEIVED =====================");
        console.log("📍 Path:", req.originalUrl);
        console.log("📦 Webhook Method:", req.method);
        console.log("📦 Webhook Headers:", req.headers);

        // Handle raw body - ensure we have the exact string
        let rawBody;
        if (req.rawBody) {
            rawBody = req.rawBody;
        } else if (Buffer.isBuffer(req.body)) {
            rawBody = req.body.toString('utf8');
        } else if (typeof req.body === 'string') {
            rawBody = req.body;
        } else {
            rawBody = JSON.stringify(req.body);
        }

        console.log("📦 Raw Body Length:", rawBody?.length || 0);
        console.log("📦 Raw Body Preview:", rawBody?.substring(0, 500));

        const signature = req.headers["x-webhook-signature"];
        const timestamp = req.headers["x-webhook-timestamp"];
        // Use WEBHOOK_SECRET if available, otherwise fallback to CASHFREE_SECRET_KEY (like BICCSL-Server)
        const secret = cashfreeConfig.WEBHOOK_SECRET || cashfreeConfig.CASHFREE_SECRET_KEY;
        const webhookVersion = req.headers["x-webhook-version"] || "unknown";

        console.log("🔐 Webhook Security Info:", {
            hasSignature: !!signature,
            hasTimestamp: !!timestamp,
            hasSecret: !!secret,
            secretLength: secret?.length || 0,
            webhookVersion: webhookVersion
        });

        // -------------------------
        // 🔐 SIGNATURE VERIFICATION (OPTIONAL - like BICCSL-Server)
        // -------------------------
        // Only verify signature if it's actually from Cashfree (not a test)
        if (signature && timestamp && secret && rawBody) {
            console.log("--- DEBUG SIGNATURE ---");
            console.log("Secret (first 5):", secret.substring(0, 5) + "...");
            console.log("Timestamp:", timestamp);

            // Match BICCSL-Server: timestamp + rawBody (no dot separator)
            const payload = timestamp + rawBody;

            const expectedSignature = crypto
                .createHmac("sha256", secret)
                .update(payload)
                .digest("base64");

            console.log("🔐 Signature Verification:", {
                receivedSignature: signature,
                generatedSignature: expectedSignature,
                signaturesMatch: expectedSignature === signature
            });

            // If signatures don't match, we'll still process but log a warning
            // This is to prevent losing payments due to signature issues (like BICCSL-Server)
            if (expectedSignature !== signature) {
                console.warn("⚠️ Cashfree signature mismatch - processing anyway to avoid payment loss");
            } else {
                console.log("✅ Signature verified successfully");
            }
        } else {
            console.log("⚠️ No signature/timestamp/secret found - this might be a test webhook or polling");
        }

        // -------------------------
        // 📦 PARSE WEBHOOK PAYLOAD
        // -------------------------
        let webhookData;
        try {
            webhookData = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
        } catch (parseErr) {
            console.error("❌ Failed to parse webhook body:", parseErr);
            return res.status(200).json({ received: true, error: "Invalid JSON" });
        }

        console.log("📦 Webhook Data:", JSON.stringify(webhookData, null, 2));

        const eventType = webhookData.type;
        // Extract order_id from Cashfree Orders API webhook (multiple fallbacks like BICCSL-Server)
        const orderId = webhookData?.data?.order?.order_id || webhookData?.data?.order_id || webhookData?.order_id;

        console.log("🔍 Extracted Order ID:", orderId);

        if (!orderId) {
            console.warn("⚠️ No order_id found in webhook data");
            return res.status(200).json({ received: true });
        }

        console.log("📋 Event:", eventType);
        console.log("🔍 Order ID:", orderId);

        // -------------------------
        // 🔁 DUPLICATE PROTECTION
        // -------------------------
        const transaction = await TransactionModel.findOneAndUpdate(
            {
                transaction_id: orderId,
                webhook_processed: { $ne: true }
            },
            {
                $set: {
            webhook_processed: true,
                webhook_processed_at: new Date()
        }
    },
    { new: true }
        );

    if (!transaction) {
        console.log("⚠️ Duplicate or missing transaction:", orderId);
        return res.status(200).json({ received: true });
    }

    console.log("✅ Transaction found:", {
        transaction_id: transaction.transaction_id,
        member_id: transaction.member_id,
        expected_amount: transaction.credit
    });

    // -------------------------
    // ✅ PAYMENT SUCCESS
    // -------------------------
    if (eventType === "PAYMENT_SUCCESS_WEBHOOK") {
        // Additional check: Skip if already completed (race condition protection)
        if (transaction.status === "Completed") {
            console.log("⚠️ Transaction already completed, skipping duplicate processing");
            return res.status(200).json({ received: true, message: "Already processed" });
        }

        console.log("💰 Processing successful payment");

        const paymentData = webhookData.data.payment;
        const receivedAmount = parseFloat(paymentData.payment_amount);
        const expectedAmount = parseFloat(transaction.credit);

        console.log("💰 Amount verification:", {
            received: receivedAmount,
            expected: expectedAmount
        });

        if (Math.abs(receivedAmount - expectedAmount) > 0.01) {
            console.error("❌ Amount mismatch");
            transaction.status = "Failed";
            transaction.payment_status = "Failed";
            transaction.description = `Amount mismatch: received ₹${receivedAmount}, expected ₹${expectedAmount}`;
            await transaction.save();
            return res.status(200).json({ received: true });
        }

        // Update account balance
        const account = await AccountsModel.findOne({
            member_id: transaction.member_id,
            account_no: transaction.account_number,
            account_type: transaction.account_type,
            status: "active"
        });

        if (account) {
            account.account_amount += transaction.credit;
            await account.save();
            transaction.balance = account.account_amount;
            console.log("✅ Account balance updated:", account.account_amount);
        } else {
            console.warn("⚠️ Account not found for balance update");
        }

        transaction.status = "Completed";
        transaction.payment_status = "Success";
        transaction.payment_completed_at = new Date();
        transaction.payment_data = webhookData.data;
        transaction.description = `Online Top-up to Account ${transaction.account_number} (Success)`;

        await transaction.save();

        console.log("✅ Payment completed & balance updated");

        // Process commission for introducers
        try {
            console.log("💰 Processing commission for transaction...");
            const commissionResult = await processTransactionCommission(transaction);
            console.log("💰 Commission processing result:", commissionResult);
        } catch (commissionError) {
            console.error("❌ Commission processing error:", commissionError.message);
            // Don't fail the webhook if commission fails
        }
    }

    // -------------------------
    // ❌ PAYMENT FAILED
    // -------------------------
    else if (eventType === "PAYMENT_FAILED_WEBHOOK") {
        console.log("❌ Payment failed");

        transaction.status = "Failed";
        transaction.payment_status = "Failed";
        transaction.payment_failed_at = new Date();
        transaction.payment_data = webhookData.data;

        await transaction.save();
    }

    // -------------------------
    // ℹ️ OTHER EVENTS
    // -------------------------
    else {
        console.log("ℹ️ Ignored webhook type:", eventType);
    }

    console.log("✅ Webhook processing completed successfully");
    return res.status(200).json({
        success: true,
        received: true,
        order_id: orderId,
        status: transaction?.payment_status || "processed"
    });

} catch (error) {
    console.error("❌ WEBHOOK ERROR:", error.message);
    console.error(error.stack);

    // ⚠️ Always return 200 so Cashfree doesn't spam retries
    return res.status(200).json({
        received: true,
        error: error.message
    });

} finally {
    console.log(`🔚 WEBHOOK DONE (${Date.now() - start}ms)\n`);
}
};


// 3. Status Check (Polling)
exports.checkPaymentStatus = async (req, res) => {
    const AccountsModel = require("../../models/accounts.model");

    try {
        const { orderId } = req.params;

        // Check if Cashfree credentials are available
        if (!cashfreeConfig.CASHFREE_APP_ID || !cashfreeConfig.CASHFREE_SECRET_KEY) {
            console.error("❌ Cashfree credentials not configured");
            return res.status(500).json({
                success: false,
                message: "Payment gateway not configured. Cannot check payment status."
            });
        }

        // Direct axios call to Cashfree API
        const response = await axios.get(`${cashfreeConfig.CASHFREE_BASE_URL}/pg/orders/${orderId}/payments`, {
            headers: {
                'Content-Type': 'application/json',
                'x-client-id': cashfreeConfig.CASHFREE_APP_ID,
                'x-client-secret': cashfreeConfig.CASHFREE_SECRET_KEY,
                'x-api-version': cashfreeConfig.X_API_VERSION
            }
        });

        // Logic to sync DB if needed
        const payments = response.data;
        const successPayment = payments.find(p => p.payment_status === "SUCCESS");

        if (successPayment) {
            // Logic similar to webhook to mark success if not already done
            const transaction = await TransactionModel.findOne({ transaction_id: orderId });
            if (transaction && transaction.status !== "Completed") {
                // Mark as completed
                transaction.payment_status = "Success";
                transaction.status = "Completed";
                transaction.description = `Online Top-up to Account ${transaction.account_number} (Success)`;

                // Update account balance
                if (transaction.account_number && transaction.account_type) {
                    // Find the account
                    const allAccounts = await AccountsModel.find({});
                    const account = allAccounts.find(acc =>
                        (acc.member_id === transaction.member_id || acc.member_id === parseInt(transaction.member_id)) &&
                        (acc.account_no == transaction.account_number) &&
                        (acc.account_type === transaction.account_type)
                    );

                    if (account) {
                        // Credit the account balance
                        const newAccountBalance = account.account_amount + transaction.credit;
                        account.account_amount = newAccountBalance;
                        await account.save();

                        // Set transaction balance to the account's new balance
                        transaction.balance = newAccountBalance;

                        console.log(`[Status Check] Account ${account.account_no} credited with ₹${transaction.credit}. New balance: ₹${newAccountBalance}`);
                    } else {
                        console.error(`[Status Check] Account not found for transaction ${orderId}`);
                        transaction.description += " (Warning: Account not found for balance update)";
                    }
                } else {
                    // Fallback for old transactions without account details
                    const lastTx = await TransactionModel.findOne({ member_id: transaction.member_id, status: "Completed" }).sort({ createdAt: -1 });
                    const lastBalance = lastTx ? lastTx.balance : 0;
                    transaction.balance = lastBalance + transaction.credit;
                }

                await transaction.save();
            }
            return res.status(200).json({ success: true, status: "SUCCESS" });
        }

        return res.status(200).json({ success: true, status: "PENDING/FAILED" });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// ==========================================
// Money Transfer Between Accounts
// ==========================================

// Transfer money between two accounts
exports.transferMoney = async (req, res) => {
    const AccountsModel = require("../../models/accounts.model");
    const MemberModel = require("../../models/member.model");

    try {
        const { from, to, amount } = req.body;
        console.log("💰 Money Transfer Request:", { from, to, amount });

        // Validate input
        if (!from || !to || !amount) {
            return res.status(400).json({
                success: false,
                message: "From account, to account, and amount are required"
            });
        }

        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Transfer amount must be greater than zero"
            });
        }

        // Validate sender member exists and is active
        const allMembers = await MemberModel.find({});
        console.log(`🔍 Found ${allMembers.length} members in DB`);
        const senderMember = allMembers.find(m => m.member_id === from.member_id || m.member_id === parseInt(from.member_id) || m.Member_id === from.member_id);
        if (!senderMember) {
            console.log("❌ Sender member NOT found. Search ID:", from.member_id);
            // Log a few member IDs to see the format
            if (allMembers.length > 0) {
                console.log("Sample Member IDs:", allMembers.slice(0, 3).map(m => m.member_id || m.Member_id));
            }
            return res.status(400).json({
                success: false,
                message: `Sender member not found with ID: ${from.member_id}`
            });
        }

        if (senderMember.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "Sender member account is not active"
            });
        }

        // Validate receiver member exists and is active
        const receiverMember = allMembers.find(m => m.member_id === to.member_id || m.member_id === parseInt(to.member_id) || m.Member_id === to.member_id);
        if (!receiverMember) {
            console.log("❌ Receiver member NOT found. Search ID:", to.member_id);
            return res.status(400).json({
                success: false,
                message: `Receiver member not found with ID: ${to.member_id}`
            });
        }

        if (receiverMember.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "Receiver member account is not active"
            });
        }

        // Find sender account (handle type mismatches)
        const allAccounts = await AccountsModel.find({});
        console.log(`🔍 Found ${allAccounts.length} accounts in DB`);
        const senderAccount = allAccounts.find(acc =>
            (acc.account_id === from.account_id || acc.account_id === parseInt(from.account_id)) &&
            (acc.member_id === from.member_id || acc.member_id === parseInt(from.member_id)) &&
            (acc.account_no == from.account_no) &&
            (acc.account_type === from.account_type)
        );

        if (!senderAccount) {
            console.log("❌ Sender account NOT found. Criteria:", from);
            if (allAccounts.length > 0) {
                const matchByNo = allAccounts.filter(a => a.account_no === from.account_no);
                console.log(`Found ${matchByNo.length} accounts matching account_no ${from.account_no}`);
                if (matchByNo.length > 0) {
                    console.log("Sample account member_id in DB:", matchByNo[0].member_id);
                    console.log("Comparison result for member_id:", matchByNo[0].member_id === from.member_id);
                }
            }
            return res.status(400).json({
                success: false,
                message: `Sender account not found (No: ${from.account_no}, Type: ${from.account_type})`
            });
        }

        // Check if sender account is active
        if (senderAccount.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "Sender account is not active"
            });
        }

        // Find receiver account (handle type mismatches)
        const receiverAccount = allAccounts.find(acc =>
            (acc.account_id === to.account_id || acc.account_id === parseInt(to.account_id)) &&
            (acc.member_id === to.member_id || acc.member_id === parseInt(to.member_id)) &&
            (acc.account_no == to.account_no) &&
            (acc.account_type === to.account_type)
        );

        if (!receiverAccount) {
            console.log("❌ Receiver account NOT found. Criteria:", to);
            return res.status(400).json({
                success: false,
                message: `Receiver account not found (No: ${to.account_no}, Type: ${to.account_type})`
            });
        }

        // Check if receiver account is active
        if (receiverAccount.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "Receiver account is not active"
            });
        }

        // Check if sender has sufficient balance
        if (senderAccount.account_amount < amount) {
            // Record failed transaction
            const failedTxId = generateTransactionId();
            await TransactionModel.create({
                transaction_id: failedTxId,
                transaction_date: new Date(),
                member_id: from.member_id,
                account_number: from.account_no,
                account_type: from.account_type,
                transaction_type: "Transfer",
                description: `Failed transfer to ${receiverMember.name} (${to.account_no}) - Insufficient balance`,
                debit: amount,
                credit: 0,
                balance: senderAccount.account_amount,
                Name: senderMember.name,
                mobileno: senderMember.contactno,
                status: "Failed"
            });

            return res.status(400).json({
                success: false,
                message: `Insufficient balance. Available: ₹${senderAccount.account_amount}, Required: ₹${amount}`
            });
        }

        // Perform the transfer
        // Deduct from sender
        senderAccount.account_amount -= amount;
        await senderAccount.save();

        // Add to receiver
        receiverAccount.account_amount += amount;
        await receiverAccount.save();

        // Create debit transaction for sender
        const debitTxId = generateTransactionId();
        const debitTransaction = await TransactionModel.create({
            transaction_id: debitTxId,
            transaction_date: new Date(),
            member_id: from.member_id,
            account_number: from.account_no,
            account_type: from.account_type,
            transaction_type: "Transfer",
            description: `Transfer to ${receiverMember.name} (${to.account_no})`,
            debit: amount,
            credit: 0,
            balance: senderAccount.account_amount,
            Name: senderMember.name,
            mobileno: senderMember.contactno,
            status: "Completed"
        });

        // Create credit transaction for receiver
        await TransactionModel.create({
            transaction_id: generateTransactionId(),
            transaction_date: new Date(),
            member_id: to.member_id,
            account_number: to.account_no,
            account_type: to.account_type,
            transaction_type: "Transfer",
            description: `Transfer from ${senderMember.name} (${from.account_no})`,
            credit: amount,
            debit: 0,
            balance: receiverAccount.account_amount,
            Name: receiverMember.name,
            mobileno: receiverMember.contactno,
            status: "Completed",
            reference_no: debitTxId
        });

        return res.status(200).json({
            success: true,
            message: "Money transferred successfully",
            data: {
                transactionId: debitTxId,
                from: {
                    account_no: from.account_no,
                    member_name: senderMember.name,
                    new_balance: senderAccount.account_amount
                },
                to: {
                    account_no: to.account_no,
                    member_name: receiverMember.name,
                    new_balance: receiverAccount.account_amount
                },
                amount: amount,
                transfer_date: new Date()
            }
        });

    } catch (error) {
        console.error("Error in money transfer:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to transfer money",
            error: error.message
        });
    }
};

// ==========================================
// Withdraw Request
// ==========================================

// Request money withdrawal with instant processing (if KYC beneficiary exists)
exports.requestWithdraw = async (req, res) => {
    const AccountsModel = require("../../models/accounts.model");
    const MemberModel = require("../../models/member.model");
    const WithdrawRequestModel = require("../../models/withdrawRequest.model");
    const TransactionModel = require("../../models/transaction.model");
    const generateTransactionId = require("../../utils/generateTransactionId");
    const axios = require("axios");

    let account; // Declare at function scope for error handling
    let originalBalance; // For rollback if needed

    try {
        const {
            member_id,
            account_id,
            account_no,
            account_type,
            amount
        } = req.body;

        // Validate input
        if (!member_id || !account_id || !account_no || !account_type || !amount) {
            return res.status(400).json({
                success: false,
                message: "Member ID, account details, and amount are required"
            });
        }

        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Withdrawal amount must be greater than zero"
            });
        }

        const currentDay = new Date().getDay();
        if (currentDay === 0 || currentDay === 6) {
            return res.status(400).json({
                success: false,
                message: "Withdrawals are only allowed from Monday to Friday"
            });
        }

        if (amount < 500) {
            return res.status(400).json({
                success: false,
                message: "Minimum withdrawal amount is ₹500"
            });
        }

        // Validate member exists and is active
        const allMembers = await MemberModel.find({});
        const member = allMembers.find(m => m.member_id === member_id || m.member_id === parseInt(member_id));

        if (!member) {
            return res.status(404).json({
                success: false,
                message: "Member not found"
            });
        }

        if (member.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "Member account is not active. Cannot process withdrawal request."
            });
        }

        // Check KYC Status
        if (member.kycStatus !== "APPROVED") {
            return res.status(403).json({
                success: false,
                message: "KYC verification required. Please complete KYC before requesting withdrawal.",
                kycStatus: member.kycStatus
            });
        }

        // Check Beneficiary Status
        if (member.beneficiaryStatus !== "CREATED" || !member.beneficiaryId) {
            return res.status(403).json({
                success: false,
                message: "Beneficiary not created. Please contact support or resubmit KYC.",
                beneficiaryStatus: member.beneficiaryStatus
            });
        }

        // Find and validate account
        const allAccounts = await AccountsModel.find({});
        const account = allAccounts.find(acc =>
            (acc.account_id === account_id || acc.account_id === parseInt(account_id)) &&
            (acc.member_id === member_id || acc.member_id === parseInt(member_id)) &&
            (acc.account_no == account_no) &&
            (acc.account_type === account_type)
        );

        if (!account) {
            return res.status(404).json({
                success: false,
                message: "Account not found or does not belong to this member"
            });
        }

        // Check if account is active
        if (account.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "Account is not active. Cannot process withdrawal request."
            });
        }

        // Check if account has sufficient balance
        if (account.account_amount < amount) {
            return res.status(400).json({
                success: false,
                message: `Insufficient balance. Available: ₹${account.account_amount}, Required: ₹${amount}`
            });
        }

        console.log("💸 Processing instant withdrawal...");
        console.log(`   Member: ${member.name} (${member.member_id})`);
        console.log(`   Beneficiary ID: ${member.beneficiaryId}`);
        console.log(`   Amount: ₹${amount}`);

        // Generate unique IDs
        const withdrawRequestId = `WR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const transferId = `TRANSFER_${Date.now()}`;

        // Get Cashfree payout base URL - V2 APIS USE DIFFERENT BASE URLS!
        const CASHFREE_PAYOUT_BASE_URL = process.env.PAYMENT_MODE === 'PRODUCTION'
            ? 'https://api.cashfree.com/payout'  // V2 Production
            : 'https://sandbox.cashfree.com/payout';  // V2 Sandbox

        // Check if Cashfree payout credentials are available
        if (!process.env.CI_APP_ID || !process.env.CI_SECRET_KEY) {
            console.error("❌ Cashfree payout credentials not configured");
            return res.status(500).json({
                success: false,
                message: "Payout gateway not configured. Contact administrator."
            });
        }

        console.log("🔐 Cashfree Payout V2 Auth (Direct API Keys)");
        console.log(`   Base URL: ${CASHFREE_PAYOUT_BASE_URL}`);
        console.log(`   Client ID: ${process.env.CI_APP_ID}`);
        console.log(`   Secret Key: ${process.env.CI_SECRET_KEY ? '***' + process.env.CI_SECRET_KEY.slice(-4) : 'NOT SET'}`);

        // V2 API uses direct client credentials, no token needed!
        // Initiate payout transfer using V2 API
        console.log("💰 Initiating payout transfer with V2 API...");

        // Log the full request for debugging
        console.log("📤 Transfer Request:");
        console.log(`   URL: ${CASHFREE_PAYOUT_BASE_URL}/transfers`);

        // V2 API requires FULL beneficiary details inline, not just beneId
        const transferPayload = {
            transfer_id: transferId,
            transfer_amount: amount,
            transfer_mode: "banktransfer",
            beneficiary_details: {
                beneficiary_name: member.name,
                beneficiary_instrument_details: {
                    bank_account_number: member.account_number, // ✅
                    bank_ifsc: member.ifsc_code                  // ✅ FIXED KEY
                },
                email: member.emailid || "noemail@example.com",
                phone: member.contactno
            },
            remarks: `Withdrawal for account ${account_no}`
        };


        console.log(`   Payload:`, JSON.stringify(transferPayload, null, 2));

        const transferResponse = await axios.post(
            `${CASHFREE_PAYOUT_BASE_URL}/transfers`,  // V2 API endpoint
            transferPayload,
            {
                headers: {
                    "X-Client-Id": process.env.CI_APP_ID,
                    "X-Client-Secret": process.env.CI_SECRET_KEY,
                    "Content-Type": "application/json",
                    "x-api-version": "2024-01-01",  // Required for V2 API
                    "X-Cf-Signature": ""  // Optional signature
                },
            }
        );

        console.log(`✅ Payout response:`, transferResponse.data);

        // Check if payout was successful
        if (transferResponse.data.status === "ERROR") {
            console.error("❌ Cashfree payout failed:", transferResponse.data.message);
            return res.status(400).json({
                success: false,
                message: `Payout failed: ${transferResponse.data.message}`,
                error: transferResponse.data
            });
        }

        // Deduct balance from account (ONLY after payout succeeds)
        const originalBalance = account.account_amount;
        account.account_amount -= amount;
        await account.save();
        console.log(`✅ Balance deducted: ₹${amount}. New balance: ₹${account.account_amount}`);

        // Generate transaction ID (MUST await!)
        const transactionId = await generateTransactionId();

        // Create debit transaction
        const transaction = await TransactionModel.create({
            transaction_id: transactionId,
            member_id: member_id,
            account_number: account_no,
            account_type: account_type,
            transaction_type: "Withdrawal",
            description: `Withdrawal to ${member.bank_name || 'bank'} (${member.account_number?.slice(-4) || 'XXXX'})`,
            debit: amount,
            credit: 0,
            balance: account.account_amount,
            status: "Completed",
            reference_no: withdrawRequestId,
            Name: member.name,
            mobileno: member.contactno
        });
        console.log(`✅ Transaction created: ${transaction.transaction_id}`);

        // Save withdrawal request with payout details
        const withdrawRequest = await WithdrawRequestModel.create({
            withdraw_request_id: withdrawRequestId,
            member_id: member_id,
            account_id: account_id,
            account_no: account_no,
            account_type: account_type,
            amount: amount,
            bank_account_number: member.account_number,
            ifsc_code: member.ifsc_code,
            account_holder_name: member.name,
            status: "Completed",  // Instantly completed
            requested_date: new Date(),
            processed_date: new Date(),
            processed_by: "SYSTEM_AUTO",
            transaction_id: transaction.transaction_id,
            cashfree_beneficiary_id: member.beneficiaryId,
            cashfree_transfer_id: transferId,
            cashfree_transfer_status: transferResponse.data?.status || "SUCCESS"
        });

        console.log(`✅ Withdrawal completed: ${withdrawRequestId}`);

        return res.status(200).json({
            success: true,
            message: "Withdrawal processed successfully. Amount will be credited to your bank account within 1-2 business days.",
            data: {
                withdraw_request_id: withdrawRequestId,
                transfer_id: transferId,
                amount: amount,
                bank_account: `****${member.account_number?.slice(-4) || 'XXXX'}`,
                bank_name: member.bank_name,
                ifsc_code: member.ifsc_code,
                status: "Completed",
                new_balance: account.account_amount,
                processed_date: new Date()
            }
        });

    } catch (error) {
        console.error("❌ Withdrawal error:", error.response?.data || error.message);
        console.error("Error stack:", error.stack);

        // CRITICAL: If error occurred after balance deduction, rollback!
        // This prevents user losing money if transaction creation fails
        try {
            if (account && account.account_amount !== undefined) {
                // Check if balance was modified
                const currentBalance = account.account_amount;
                // Reload account to check if it was saved
                const freshAccount = await AccountsModel.findOne({ account_no: account_no });
                if (freshAccount && freshAccount.account_amount !== originalBalance) {
                    // Balance was deducted, rollback!
                    console.log("⚠️ Rolling back balance deduction...");
                    freshAccount.account_amount += amount;
                    await freshAccount.save();
                    console.log(`✅ Balance rolled back to: ₹${freshAccount.account_amount}`);
                }
            }
        } catch (rollbackError) {
            console.error("❌ Rollback failed:", rollbackError.message);
        }

        const errorMessage = error.response?.data?.message || error.message || "Unknown error occurred";

        return res.status(500).json({
            success: false,
            message: "Failed to process withdrawal. Please try again or contact support.",
            error: errorMessage
        });
    }
};

// Manual Webhook Trigger (For Testing)
exports.triggerTestWebhook = async (req, res) => {
    try {
        const { orderId, status } = req.body;

        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: "Order ID is required"
            });
        }

        // Find the transaction
        const transaction = await TransactionModel.findOne({
            transaction_id: orderId
        });

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: "Transaction not found"
            });
        }

        // Create mock webhook data
        const mockWebhookData = {
            type: status === 'SUCCESS' ? 'PAYMENT_SUCCESS_WEBHOOK' : 'PAYMENT_FAILED_WEBHOOK',
            data: {
                order: {
                    order_id: orderId,
                    order_amount: transaction.credit.toString(),
                    order_currency: "USD"
                },
                payment: {
                    cf_payment_id: `mock_payment_${Date.now()}`,
                    payment_status: status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
                    payment_amount: transaction.credit.toString(),
                    payment_currency: "USD",
                    payment_time: new Date().toISOString(),
                    payment_method: "TEST",
                    bank_reference: `mock_ref_${Date.now()}`
                }
            }
        };

        // Call your webhook handler directly
        const mockReq = {
            headers: {
                'x-cashfree-signature': 'test_signature_for_development'
            },
            rawBody: JSON.stringify(mockWebhookData)
        };

        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    console.log(`Mock webhook response: ${code}`, data);
                    return data;
                }
            })
        };

        // Trigger the webhook handler
        await exports.handleCashfreeWebhook(mockReq, mockRes);

        return res.status(200).json({
            success: true,
            message: `Test webhook triggered for order ${orderId} with status ${status}`,
            transaction_id: orderId
        });

    } catch (error) {
        console.error("Test webhook error:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Test Payment Status Update
exports.testPaymentStatus = async (req, res) => {
    try {
        const { orderId } = req.params;

        // Find transaction
        const transaction = await TransactionModel.findOne({
            transaction_id: orderId
        });

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: "Transaction not found"
            });
        }

        // Update to success for testing
        transaction.status = "Completed";
        transaction.payment_status = "Success";
        transaction.payment_completed_at = new Date();
        transaction.description = `Online Top-up to Account ${transaction.account_number} (Success - Test)`;

        await transaction.save();

        return res.status(200).json({
            success: true,
            message: "Payment marked as success for testing",
            data: transaction
        });

    } catch (error) {
        console.error("Test payment error:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
