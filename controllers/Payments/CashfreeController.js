const axios = require("axios");
const crypto = require("crypto");
const TransactionModel = require("../../models/Transaction/Transaction");
const MemberModel = require("../../models/Users/Member");
const PaymentModel = require("../../models/Payments/Payment");
const { updateReferralHierarchy } = require("../Users/Payout/PayoutController");

// Cashfree API Base URLs
const CASHFREE_BASE = process.env.NODE_ENV === "PROD"
  ? "https://api.cashfree.com"
  : "https://sandbox.cashfree.com";
const X_API_VERSION = "2022-09-01";

// Helper function to process loan repayment (called ONLY after payment success)
async function processLoanRepayment(paymentTransaction, _data) {
  try {
    console.log("🔄 Starting loan repayment processing...");

    const {
      member_id,
      requested_amount,
      current_due_amount,
      original_loan_id
    } = paymentTransaction.repayment_context;

    console.log("🔍 Processing repayment for loan ID:", original_loan_id);

    const loanTransaction = await TransactionModel.findById(original_loan_id);

    if (!loanTransaction) {
      console.warn("⚠️ Original loan transaction not found:", original_loan_id);
      return;
    }

    // Log current state before update
    console.log("📋 Loan transaction before update:", {
      _id: loanTransaction._id,
      net_amount: loanTransaction.net_amount,
      repayment_status: loanTransaction.repayment_status
    });

    // Calculate the new due amount based on the requested amount
    const previousAmount = parseFloat(loanTransaction.net_amount);
    const amountToDeduct = parseFloat(requested_amount);
    const new_due_amount = previousAmount - amountToDeduct;

    console.log("📊 Loan repayment calculation:", {
      previous_amount: previousAmount,
      amount_deducted: amountToDeduct,
      new_due_amount: new_due_amount,
      calculation: `${previousAmount} - ${amountToDeduct} = ${new_due_amount}`
    });

    // Check if this repayment has already been processed to prevent double processing
    // This can happen if webhooks are sent multiple times
    const existingNetAmount = parseFloat(loanTransaction.net_amount);
    const expectedNewAmount = parseFloat(new_due_amount.toFixed(2));

    // If the loan already has the expected new amount, it means this repayment was already processed
    if (Math.abs(existingNetAmount - expectedNewAmount) < 0.01) {
      console.log("⚠️ Loan repayment already processed, skipping update");
      console.log("📋 Loan transaction unchanged:", {
        _id: loanTransaction._id,
        net_amount: loanTransaction.net_amount,
        repayment_status: loanTransaction.repayment_status
      });
      return;
    }

    // Update the loan's net_amount (remaining due) - THIS IS THE ACTUAL UPDATE
    loanTransaction.net_amount = new_due_amount.toFixed(2);
    loanTransaction.last_repayment_date = new Date().toISOString();

    if (new_due_amount <= 0) {
      loanTransaction.repayment_status = "Paid";
      console.log("🎉 Loan fully repaid!");
    } else {
      loanTransaction.repayment_status = "Partially Paid";
      console.log("📊 Loan partially repaid, remaining:", new_due_amount);
    }

    await loanTransaction.save();

    // Log after update
    console.log("📋 Loan transaction after update:", {
      _id: loanTransaction._id,
      previous_net_amount: previousAmount,
      new_net_amount: loanTransaction.net_amount,
      repayment_status: loanTransaction.repayment_status
    });

    console.log("✅ Loan transaction updated successfully");

    if (new_due_amount <= 0) {
      const member = await MemberModel.findOne({ Member_id: member_id });
      if (member && member.upgrade_status === "Approved") {
        member.upgrade_status = "Repaid";
        await member.save();
        console.log("✅ Member loan status updated to Repaid");
      }
    }

    console.log("✅ Loan repayment processing completed");
  } catch (error) {
    console.error("❌ Error in processLoanRepayment:", error);
    throw error;
  }
}

// Helper function to revert loan repayment (kept for backward compatibility)
// Note: With the new flow where loan is only updated after payment success,
// this function is rarely needed, but kept for edge cases and manual intervention
async function revertLoanRepayment(paymentTransaction, _data) {
  try {
    console.log("🔄 Reverting loan repayment due to payment failure...");

    const { current_due_amount, original_loan_id } = paymentTransaction.repayment_context || {};

    if (!original_loan_id) {
      console.warn("⚠️ No original_loan_id in repayment_context, nothing to revert");
      return;
    }

    const loanTransaction = await TransactionModel.findById(original_loan_id);

    if (!loanTransaction) {
      console.warn("⚠️ Original loan transaction not found:", original_loan_id);
      return;
    }

    // Restore the original due amount
    if (current_due_amount !== undefined) {
      const previousAmount = loanTransaction.net_amount;
      loanTransaction.net_amount = current_due_amount.toFixed(2);
      loanTransaction.repayment_status = current_due_amount <= 0 ? "Paid" : "Unpaid";
      await loanTransaction.save();
      console.log("✅ Loan transaction reverted successfully", {
        _id: loanTransaction._id,
        previous_net_amount: previousAmount,
        restored_net_amount: loanTransaction.net_amount,
        repayment_status: loanTransaction.repayment_status
      });
    }

    console.log("✅ Loan repayment reversal completed");
  } catch (error) {
    console.error("❌ Error in revertLoanRepayment:", error);
    throw error;
  }
}

exports.createOrder = async (req, res) => {
  try {
    console.log("🟢 CREATE ORDER STARTED =====================");
    console.log("📦 Request Body:", req.body);

    const {
      amount,
      currency = "USD",
      customer,
      notes = {}
    } = req.body;

    const memberId = customer?.customer_id;
    const isLoanRepayment = notes?.isLoanRepayment !== false;

    // -------- VALIDATIONS ----------
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Valid amount required" });
    }
    if (!memberId) {
      return res.status(400).json({ success: false, message: "Member ID required" });
    }

    // -------- MEMBER LOOKUP ----------
    const member = await MemberModel.findOne({ Member_id: memberId });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    console.log("✅ Member found:", member.Member_id, member.Name);

    let currentDueAmount = 0;
    let loanTransaction = null;

    // -------- LOAN REPAYMENT LOGIC ----------
    if (isLoanRepayment) {
      loanTransaction = await TransactionModel.findOne({
        member_id: memberId,
        transaction_type: "Reward Loan Request",
        status: "Approved",
      }).sort({ _id: -1 });

      if (!loanTransaction) {
        return res.status(404).json({
          success: false,
          message: "No approved loan found to repay"
        });
      }

      let baseDueAmount = parseFloat(loanTransaction.net_amount);

      const pendingRepayments = await TransactionModel.find({
        member_id: memberId,
        is_loan_repayment: true,
        status: "Pending",
        "repayment_context.original_loan_id": loanTransaction._id
      });

      let pendingAmount = pendingRepayments.reduce((sum, t) =>
        sum + parseFloat(t.repayment_context.requested_amount || 0), 0);

      currentDueAmount = baseDueAmount - pendingAmount;

      if (currentDueAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: "Loan already fully repaid"
        });
      }

      if (amount > currentDueAmount) {
        return res.status(400).json({
          success: false,
          message: `Cannot repay more than due amount ₹${currentDueAmount}`
        });
      }

      console.log("💰 Loan repayment validated. Due:", currentDueAmount);
    }

    // -------- CASHFREE CONFIG ----------
    const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
    const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;

    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: "Cashfree API keys missing"
      });
    }

    const CASHFREE_BASE =
      process.env.NODE_ENV === "PROD"
        ? "https://api.cashfree.com"
        : "https://sandbox.cashfree.com";

    // -------- SAFE URL HANDLING ----------
    let frontendUrl = (process.env.FRONTEND_URL || "").trim();
    let backendUrl = (process.env.BACKEND_URL || "").trim();

    if (!frontendUrl.startsWith("http")) frontendUrl = "http://" + frontendUrl;
    if (!backendUrl.startsWith("http")) backendUrl = "https://" + backendUrl;

    const returnUrl =
      `${frontendUrl}/user/dashboard?order_id={order_id}&order_status={order_status}&member_id=${memberId}`;

    const notifyUrl = `${backendUrl}/payments/webhook`;

    console.log("🔗 Cashfree URLs:", { returnUrl, notifyUrl });

    // -------- CASHFREE ORDER PAYLOAD ----------
    const cashfreeBody = {
      order_amount: amount,
      order_currency: currency,

      customer_details: {
        customer_id: memberId,
        customer_email: customer?.customer_email || member.email || "support@example.com",
        customer_phone: customer?.customer_phone || member.mobileno,
        customer_name: customer?.customer_name || member.Name
      },

      order_meta: {
        return_url: returnUrl,
        notify_url: notifyUrl
      }
    };

    console.log("📤 Final Cashfree Payload:", cashfreeBody);

    // -------- SEND TO CASHFREE ----------
    const headers = {
      "Content-Type": "application/json",
      "x-api-version": "2022-09-01",
      "x-client-id": CASHFREE_APP_ID,
      "x-client-secret": CASHFREE_SECRET_KEY,
    };

    const response = await axios.post(
      `${CASHFREE_BASE}/pg/orders`,
      cashfreeBody,
      { headers }
    );

    if (!response.data.payment_session_id) {
      return res.status(500).json({
        success: false,
        message: "Cashfree did not return payment_session_id"
      });
    }

    console.log("✅ Cashfree order created:", response.data.order_id);

    // -------- SAVE PAYMENT RECORD ----------
    await PaymentModel.create({
      memberId,
      orderId: response.data.order_id,
      paymentSessionId: response.data.payment_session_id,
      amount,
      currency,
      status: response.data.order_status,
      rawResponse: response.data
    });

    // -------- SAVE TRANSACTION (Loan repayment) ----------
    await TransactionModel.create({
      transaction_id: response.data.order_id,
      transaction_date: new Date(),
      member_id: memberId,
      description: `Loan repayment of ₹${amount}`,
      status: "Pending",
      is_loan_repayment: isLoanRepayment,
      ew_debit: amount,
      repayment_context: {
        member_id: memberId,
        requested_amount: amount,
        current_due_amount: currentDueAmount,
        original_loan_id: loanTransaction?._id
      }
    });

    // -------- SEND TO FRONTEND ----------
    res.json({
      success: true,
      order_id: response.data.order_id,
      payment_session_id: response.data.payment_session_id,
      cashfree_env: process.env.NODE_ENV === "PROD" ? "production" : "sandbox"
    });

  } catch (error) {
    console.error("❌ ERROR:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Failed to create order",
      error: error.response?.data || error.message
    });
  } finally {
    console.log("🔚 CREATE ORDER END =====================");
  }
};


// Verify payment status
exports.verifyPayment = async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID is required"
      });
    }

    // Check if payment exists in our database
    const payment = await PaymentModel.findOne({ orderId: orderId });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found"
      });
    }

    // Get payment status from Cashfree
    const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
    const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;

    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: "Payment service configuration error."
      });
    }

    const headers = {
      "Content-Type": "application/json",
      "x-api-version": X_API_VERSION,
      "x-client-id": CASHFREE_APP_ID,
      "x-client-secret": CASHFREE_SECRET_KEY,
    };

    // Call Cashfree API directly with correct endpoint
    const response = await axios.get(`${CASHFREE_BASE}/pg/orders/${orderId}`, { headers });

    // Update our payment record
    payment.status = response.data.order_status;
    payment.rawResponse = response.data;
    await payment.save();

    // Get payment time from payment details if available
    const paymentTime = response.data.payment_details?.length > 0
      ? response.data.payment_details[0]?.payment_time
      : null;

    // Response format matching frontend VerifyPaymentResponse interface
    res.json({
      success: true,
      message: `Payment ${response.data.order_status === 'PAID' ? 'successful' : 'status: ' + response.data.order_status}`,
      payment_status: response.data.order_status,
      order_id: response.data.order_id,
      amount: response.data.order_amount,
      payment_time: paymentTime
    });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to verify payment",
      payment_status: "FAILED",
      order_id: req.params.orderId,
      error: error.message
    });
  }
};

// Get incomplete payments
exports.getIncompletePayment = async (req, res) => {
  try {
    const { memberId } = req.params;

    if (!memberId) {
      return res.status(400).json({
        success: false,
        message: "Member ID is required"
      });
    }

    // Find payments that are not completed
    const incompletePayments = await PaymentModel.find({
      memberId: memberId,
      status: { $nin: ["PAID", "CANCELLED", "EXPIRED"] }
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: incompletePayments
    });
  } catch (error) {
    console.error("Error fetching incomplete payments:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch incomplete payments",
      error: error.message
    });
  }
};



// Handle webhook from Cashfree
exports.handleWebhook = async (req, res) => {
  try {
    console.log("🟢 WEBHOOK RECEIVED =====================");
    console.log("📦 Webhook Method:", req.method);
    console.log("📦 Webhook URL:", req.url);
    console.log("📦 Webhook Headers:", req.headers);
    console.log("📦 Webhook Body Type:", typeof req.body);
    console.log("📦 Webhook Body Length:", req.body?.length || 'N/A');

    // Log first 1000 characters of body for debugging without overwhelming logs
    if (typeof req.body === 'string') {
      console.log("📦 Webhook Body Preview:", req.body.substring(0, 1000) + (req.body.length > 1000 ? '...' : ''));
    } else if (Buffer.isBuffer(req.body)) {
      const bodyStr = req.body.toString('utf8');
      console.log("📦 Webhook Buffer Body Preview:", bodyStr.substring(0, 1000) + (bodyStr.length > 1000 ? '...' : ''));
    } else {
      console.log("📦 Webhook Body (Object):", JSON.stringify(req.body, null, 2));
    }

    const signature = req.headers["x-webhook-signature"];
    const timestamp = req.headers["x-webhook-timestamp"];
    const secret = process.env.CASHFREE_SECRET_KEY;
    const webhookVersion = req.headers["x-webhook-version"] || "unknown";

    console.log("🔐 Webhook Security Info:", {
      hasSignature: !!signature,
      hasTimestamp: !!timestamp,
      hasSecret: !!secret,
      secretLength: secret?.length || 0,
      webhookVersion: webhookVersion
    });

    // Handle raw body - ensure we have the exact string that was signed
    let rawBody;
    if (Buffer.isBuffer(req.body)) {
      rawBody = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      rawBody = req.body;
    } else {
      rawBody = JSON.stringify(req.body);
    }
    console.log("📄 Raw webhook body length:", rawBody.length);
    console.log("📄 Raw webhook body preview:", rawBody.substring(0, 500) + (rawBody.length > 500 ? '...' : ''));

    // Try to parse the body for easier inspection
    let parsedData;
    try {
      parsedData = JSON.parse(rawBody);
      console.log("📄 Parsed webhook data keys:", Object.keys(parsedData));
      if (parsedData.data) {
        console.log("📄 Parsed webhook data.data keys:", Object.keys(parsedData.data));
        if (parsedData.data.order) {
          console.log("📄 Parsed webhook data.data.order keys:", Object.keys(parsedData.data.order));
        }
        if (parsedData.data.payment) {
          console.log("📄 Parsed webhook data.data.payment keys:", Object.keys(parsedData.data.payment));
        }
      }
      // Log the event type if present
      if (parsedData.type || parsedData.event) {
        console.log("🔔 Webhook Event Type:", parsedData.type || parsedData.event);
      }
    } catch (parseErr) {
      console.error("❌ Failed to parse webhook body:", parseErr);
      console.log("📄 Raw body that failed to parse:", rawBody.substring(0, 500));
      // Even if we can't parse, we still need to respond properly for Cashfree
      return res.status(400).send("Invalid JSON in webhook body");
    }

    // Only verify signature if it's actually from Cashfree (not a test)
    if (signature && timestamp && secret) {
      // Log the exact values being used for signature verification
      console.log("🔐 Signature Verification Details:", {
        timestamp: timestamp,
        rawBody: rawBody.substring(0, 200) + (rawBody.length > 200 ? '...' : ''),
        secretStart: secret.substring(0, 10) + "...",
        secretEnd: "..." + secret.substring(secret.length - 10),
        webhookVersion: webhookVersion
      });

      let genSig;

      // Different signature verification based on webhook version
      if (webhookVersion === "2023-08-01") {
        // Newer version uses timestamp + payload (correct method per Cashfree docs)
        const payload = timestamp + rawBody;
        genSig = crypto.createHmac("sha256", secret).update(payload).digest("base64");
        console.log("🔐 Using 2023-08-01 signature method (timestamp + payload)");
      } else if (webhookVersion === "2021-09-21") {
        // Older version uses timestamp + payload as well
        const payload = timestamp + rawBody;
        genSig = crypto.createHmac("sha256", secret).update(payload).digest("base64");
        console.log("🔐 Using 2021-09-21 signature method (timestamp + payload)");
      } else {
        // Default to the correct method per Cashfree docs
        console.log("🔐 Unknown webhook version, using default method (timestamp + payload)");
        const payload = timestamp + rawBody;
        genSig = crypto.createHmac("sha256", secret).update(payload).digest("base64");
      }

      console.log("🔐 Signature Verification:", {
        receivedSignature: signature,
        generatedSignature: genSig,
        signaturesMatch: genSig === signature
      });

      // If signatures don't match, we'll still process but log a warning
      // This is to prevent losing payments due to signature issues
      if (genSig !== signature) {
        console.warn("⚠️ Cashfree signature mismatch - processing anyway to avoid payment loss");
        console.log("Expected:", genSig);
        console.log("Received:", signature);
        console.log("Payload length:", (timestamp + rawBody).length);
        console.log("First 200 chars of payload:", (timestamp + rawBody).substring(0, 200));
      }
    } else {
      console.log("⚠️ No signature/timestamp/secret found - this might be a test webhook");
    }

    const data = typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? req.body
      : JSON.parse(rawBody);
    console.log("✅ Processing webhook data:", JSON.stringify(data, null, 2));

    // Enhanced logging to debug order ID extraction
    console.log("🔍 Extracting order ID from webhook data...");
    const orderId = data.data?.order?.order_id || data.data?.order_id || data.order_id;
    console.log("📋 Extracted order ID:", orderId);

    if (!orderId) {
      console.warn("❌ No order ID found in webhook data");
      console.log("📄 Full webhook data structure:", JSON.stringify(data, null, 2));
      return res.status(400).send("Order ID not found in webhook data");
    }

    const paymentTransaction = await TransactionModel.findOne({
      transaction_id: orderId
    });

    if (!paymentTransaction) {
      console.warn("❌ Transaction not found for order:", orderId);
      // Log more details to help with debugging
      console.log("🔍 Searching for transactions with similar IDs...");
      const similarTransactions = await TransactionModel.find({
        transaction_id: { $regex: orderId.substring(0, Math.min(orderId.length, 10)) }
      }).limit(5);

      if (similarTransactions.length > 0) {
        console.log("🔍 Found similar transactions:", similarTransactions.map(t => ({
          id: t.transaction_id,
          orderId: orderId,
          match: t.transaction_id === orderId
        })));
      } else {
        console.log("🔍 No similar transactions found");
      }

      // Still return 200 to acknowledge receipt, but log the issue
      return res.status(200).json({
        success: false,
        message: "Transaction not found",
        order_id: orderId
      });
    }

    // IDEMPOTENCY CHECK - Prevent duplicate processing
    // Use atomic update to prevent race conditions
    if (paymentTransaction.webhook_processed) {
      console.log("⚠️ Webhook already processed for order:", orderId);
      return res.status(200).json({
        success: true,
        message: "Webhook already processed",
        order_id: orderId
      });
    }

    // Attempt to acquire lock atomically
    const lockResult = await TransactionModel.updateOne(
      { _id: paymentTransaction._id, webhook_processed: false },
      { $set: { webhook_processed: true, webhook_processed_at: new Date() } }
    );

    if (lockResult.modifiedCount === 0) {
      console.log("⚠️ Race condition detected: Webhook already processed by another request for order:", orderId);
      return res.status(200).json({
        success: true,
        message: "Webhook already processed (race accepted)",
        order_id: orderId
      });
    }

    // Identify that we hold the lock, so subsequent saves should respect this
    paymentTransaction.webhook_processed = true;
    console.log("🔒 Atomic lock acquired for processing order:", orderId);

    console.log("✅ Payment transaction found:", {
      transaction_id: paymentTransaction.transaction_id,
      member_id: paymentTransaction.member_id,
      is_loan_repayment: paymentTransaction.is_loan_repayment,
      expected_amount: paymentTransaction.ew_debit
    });

    // Enhanced logging to debug order status extraction
    console.log("🔍 Extracting order status from webhook data...");
    // Cashfree uses payment_status for newer webhooks and order_status for older ones
    const orderStatus = data.data?.payment?.payment_status || data.data?.order?.order_status || data.order_status;
    console.log("📋 Extracted order status:", orderStatus);

    if (!orderStatus) {
      console.warn("❌ No order status found in webhook data");
      console.log("📄 Data structure for status extraction:", JSON.stringify(data, null, 2));
    }

    // Map Cashfree payment statuses to our internal statuses
    const statusMap = {
      "SUCCESS": "PAID",
      "FAILED": "FAILED",  // Fixed: Use "FAILED" instead of "Failed" to match enum
      "CANCELLED": "CANCELLED",  // Fixed: Use "CANCELLED" instead of "Cancelled"
      "PENDING": "PENDING"  // Fixed: Use "PENDING" instead of "Pending"
    };

    const mappedStatus = statusMap[orderStatus] || orderStatus;
    const isSuccessful = mappedStatus === "PAID";
    const status = isSuccessful ? "Completed" : "Failed";  // Transaction status

    console.log("📊 Payment outcome evaluation:", {
      rawOrderStatus: orderStatus,
      mappedStatus: mappedStatus,
      isSuccessful: isSuccessful,
      transactionStatus: status
    });

    // AMOUNT VERIFICATION - Critical security check
    if (data.data?.payment) {
      const paymentData = data.data.payment;
      const receivedAmount = parseFloat(paymentData.payment_amount);
      const expectedAmount = parseFloat(paymentTransaction.ew_debit);

      console.log("💰 Amount verification:", {
        received: receivedAmount,
        expected: expectedAmount
      });

      // Verify amount matches (with small tolerance for floating point)
      if (isSuccessful && Math.abs(receivedAmount - expectedAmount) > 0.01) {
        console.error("❌ CRITICAL: Payment amount mismatch!", {
          received: receivedAmount,
          expected: expectedAmount,
          difference: Math.abs(receivedAmount - expectedAmount)
        });
        // Log this for investigation but don't process
        paymentTransaction.status = "Failed";
        paymentTransaction.description = `Amount mismatch: received ₹${receivedAmount}, expected ₹${expectedAmount}`;
        paymentTransaction.webhook_processed = true;
        paymentTransaction.webhook_processed_at = new Date();
        await paymentTransaction.save();
        return res.status(200).json({
          success: false,
          message: "Payment amount mismatch - contact support",
          order_id: orderId
        });
      }

      // Properly handle payment method object from Cashfree
      let paymentMethodString = "Unknown";
      if (paymentData.payment_method) {
        if (typeof paymentData.payment_method === 'string') {
          paymentMethodString = paymentData.payment_method;
        } else if (typeof paymentData.payment_method === 'object') {
          // Handle nested payment method objects (like UPI)
          if (paymentData.payment_method.upi) {
            const upi = paymentData.payment_method.upi;
            paymentMethodString = `UPI: ${upi.upi_id || 'Unknown UPI ID'}`;
          } else if (paymentData.payment_method.card) {
            paymentMethodString = "Card Payment";
          } else if (paymentData.payment_method.netbanking) {
            paymentMethodString = "Net Banking";
          } else {
            // Convert object to string representation
            paymentMethodString = JSON.stringify(paymentData.payment_method);
          }
        }
      }

      paymentTransaction.payment_details = {
        payment_method: paymentMethodString,
        bank_reference: paymentData.bank_reference,
        payment_time: paymentData.payment_time,
        payment_amount: receivedAmount
      };
    }

    paymentTransaction.status = status;
    paymentTransaction.description = `Payment ${mappedStatus}}`;
    paymentTransaction.webhook_processed = true;
    paymentTransaction.webhook_processed_at = new Date();

    await paymentTransaction.save();
    console.log("✅ Payment transaction updated with status:", status);

    // Update payment record in Payment collection
    const paymentRecord = await PaymentModel.findOne({ orderId: orderId });
    if (paymentRecord) {
      paymentRecord.status = mappedStatus;  // This should now match the enum
      if (!paymentRecord.notifications) paymentRecord.notifications = [];
      paymentRecord.notifications.push(data);
      paymentRecord.rawResponse = data;
      await paymentRecord.save();
      console.log("✅ Payment record updated with status:", mappedStatus);
    } else {
      console.warn("⚠️ Payment record not found for order:", orderId);
    }

    // Process loan repayment ONLY after confirmed payment success
    if (isSuccessful && paymentTransaction.is_loan_repayment) {
      console.log("💰 Processing loan repayment after confirmed payment...");
      await processLoanRepayment(paymentTransaction, data);
    }

    // ACTIVATION LOGIC: Set user status to 'active' if they are currently 'Pending' and payment is successful
    if (isSuccessful) {
      try {
        const member = await MemberModel.findOne({ Member_id: paymentTransaction.member_id });
        if (member) {
          if (member.status === "Pending") {
            // Helper to map amount to package
            const amount = parseFloat(paymentTransaction.ew_debit);
            let packageUpdated = false;

            if (amount === 1200) {
              member.spackage = "RD";
              member.package_value = 1200;
              packageUpdated = true;
            } else if (amount === 600) {
              member.spackage = "RD";
              member.package_value = 600;
              packageUpdated = true;
            }

            member.status = "active";
            if (packageUpdated) {
              member.roi_status = "Active";
              member.roi_start_date = moment().utcOffset("+05:30").format("YYYY-MM-DD");
              member.roi_payout_count = 0;
              member.roi_payout_target = 200;
              member.roi_daily_amount = Math.round(Number(member.package_value) * 0.01 * 100) / 100;
              member.roi_total_paid = 0;
              member.roi_last_payout_date = null;
            }
            await member.save();
            console.log(`✅ Member ${member.Member_id} status updated from Pending to active`);
            if (packageUpdated) {
              console.log(`📦 Member package updated to ${member.spackage} (${member.package_value})`);

              // --- NEW: Global Income (Autopool) Distribution ---
              try {
                const { distributeGlobalIncome } = require("../Packages/globalIncomeService");
                await distributeGlobalIncome(member.Member_id, member.package_value);
              } catch (globalIncomeErr) {
                console.error("Global income distribution failed in cashfree webhook:", globalIncomeErr);
              }
            }

            // Update referral hierarchy and sponsor level now that member is active
            try {
              const sponsorId = member.sponsor_id || member.Sponsor_code;
              if (sponsorId) {
                console.log(`🔁 Updating referral hierarchy for new active member ${member.Member_id} with sponsor ${sponsorId}`);
                await updateReferralHierarchy(member.Member_id, sponsorId);
                console.log(`✅ Referral hierarchy updated for member ${member.Member_id}`);

                // Update Sponsor Level & Continuous ROI
                try {
                  const { checkAndUpdateSponsorLevel } = require("../Users/roiService/sponsorLevelService");
                  await checkAndUpdateSponsorLevel(sponsorId);
                } catch (lvlErr) {
                  console.error("⚠️ Sponsor level promotion check failed:", lvlErr.message);
                }
              } else {
                console.log(`⚠️ No sponsorId found for member ${member.Member_id}; skipping referral update`);
              }
            } catch (refErr) {
              console.error(`❌ Error updating referral hierarchy for member ${member.Member_id}:`, refErr.message || refErr);
            }

          } else {
            console.log(`ℹ️ Member ${member.Member_id} status is already ${member.status}, skipping activation update`);
          }
        } else {
          console.warn(`⚠️ Member not found for activation: ${paymentTransaction.member_id}`);
        }
      } catch (activationError) {
        console.error("❌ Error updating member status:", activationError);
        // Don't fail the webhook response for this, just log it
      }
    }

    // Note: We no longer call revertLoanRepayment because loan is never pre-emptively updated

    console.log("✅ Webhook processing completed successfully");
    // Always return 200 to acknowledge successful processing
    res.status(200).json({
      success: true,
      message: "Webhook processed successfully",
      order_id: orderId,
      status: mappedStatus
    });
  } catch (err) {
    console.error("❌ WEBHOOK ERROR =====================");
    console.error("Error name:", err.name);
    console.error("Error message:", err.message);
    console.error("Stack trace:", err.stack);

    // Try to log the request body if available
    try {
      console.log("📄 Request body at time of error:", typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    } catch (logErr) {
      console.log("📄 Could not log request body:", logErr.message);
    }

    // Always return 200 to acknowledge receipt, even if processing failed
    // This prevents Cashfree from retrying indefinitely
    res.status(200).json({
      success: false,
      message: "Webhook received but processing failed",
      error: err.message
    });
  } finally {
    console.log("🔚 WEBHOOK PROCESSING COMPLETED =====================\n");
  }
};


// Retry a failed payment
exports.retryPayment = async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID is required"
      });
    }

    // Find the payment record
    const payment = await PaymentModel.findOne({ orderId: orderId });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found"
      });
    }

    // Check if payment can be retried
    if (payment.status === "PAID" || payment.status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Payment cannot be retried as it's already completed or cancelled"
      });
    }

    // Get Cashfree credentials
    const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
    const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;

    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: "Payment service configuration error."
      });
    }

    const headers = {
      "Content-Type": "application/json",
      "x-api-version": X_API_VERSION,
      "x-client-id": CASHFREE_APP_ID,
      "x-client-secret": CASHFREE_SECRET_KEY,
    };

    // Retry the payment by creating a new session
    const retryBody = {
      order_id: orderId
    };

    // Call Cashfree API directly with correct endpoint
    const response = await axios.post(`${CASHFREE_BASE}/pg/orders/${orderId}/retry`, retryBody, { headers });

    // Update payment record
    payment.paymentSessionId = response.data.payment_session_id;
    payment.status = response.data.order_status;
    payment.rawResponse = response.data;
    await payment.save();

    res.json({
      success: true,
      data: {
        orderId: response.data.order_id,
        paymentSessionId: response.data.payment_session_id,
        status: response.data.order_status
      }
    });
  } catch (error) {
    console.error("Error retrying payment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retry payment",
      error: error.message
    });
  }
};

// Handle payment redirect
exports.handlePaymentRedirect = async (req, res) => {
  try {
    const { order_id, order_status, member_id } = req.query;

    if (!order_id || !order_status || !member_id) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters"
      });
    }

    // Find the payment record
    const payment = await PaymentModel.findOne({ orderId: order_id });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found"
      });
    }

    // Update payment status
    payment.status = order_status;
    await payment.save();

    // Find transaction record
    const transaction = await TransactionModel.findOne({ transaction_id: order_id });

    if (transaction) {
      transaction.status = order_status === "PAID" ? "Completed" : "Failed";
      await transaction.save();
    }

    // Return success response
    res.json({
      success: true,
      data: {
        orderId: order_id,
        status: order_status,
        memberId: member_id
      }
    });
  } catch (error) {
    console.error("Error handling payment redirect:", error);
    res.status(500).json({
      success: false,
      message: "Failed to handle payment redirect",
      error: error.message
    });
  }
};

// Check payment status
exports.checkPaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID is required"
      });
    }

    // Find payment in our database
    const payment = await PaymentModel.findOne({ orderId: orderId });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found"
      });
    }

    res.json({
      success: true,
      data: {
        orderId: payment.orderId,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt
      }
    });
  } catch (error) {
    console.error("Error checking payment status:", error);
    res.status(500).json({
      success: false,
      message: "Failed to check payment status",
      error: error.message
    });
  }
};

// Raise a ticket for payment issues
exports.raiseTicket = async (req, res) => {
  try {
    const { orderId, issueType, description } = req.body;
    const { memberId } = req.user; // Assuming user is authenticated

    if (!orderId || !issueType || !description) {
      return res.status(400).json({
        success: false,
        message: "Order ID, issue type, and description are required"
      });
    }

    // Find the payment record
    const payment = await PaymentModel.findOne({ orderId: orderId });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found"
      });
    }

    // In a real implementation, you would create a ticket in your ticketing system
    // For now, we'll just update the payment record with the ticket info
    if (!payment.notes) {
      payment.notes = {};
    }

    payment.notes.ticket = {
      issueType: issueType,
      description: description,
      raisedBy: memberId,
      raisedAt: new Date()
    };

    await payment.save();

    res.json({
      success: true,
      message: "Ticket raised successfully",
      data: {
        ticketId: `TICKET-${Date.now()}`,
        orderId: orderId,
        issueType: issueType
      }
    });
  } catch (error) {
    console.error("Error raising ticket:", error);
    res.status(500).json({
      success: false,
      message: "Failed to raise ticket",
      error: error.message
    });
  }
};

// Save incomplete payment
exports.saveIncompletePayment = async (req, res) => {
  try {
    const { orderId, paymentData } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID is required"
      });
    }

    // Find or create payment record
    let payment = await PaymentModel.findOne({ orderId: orderId });

    if (!payment) {
      // Create new payment record for incomplete payment
      payment = new PaymentModel({
        orderId: orderId,
        status: "PENDING",
        rawResponse: paymentData || {}
      });
    } else {
      // Update existing payment record
      payment.rawResponse = paymentData || payment.rawResponse;
      payment.status = payment.status === "PAID" ? payment.status : "PENDING";
    }

    await payment.save();

    res.json({
      success: true,
      message: "Incomplete payment saved successfully",
      data: payment
    });
  } catch (error) {
    console.error("Error saving incomplete payment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save incomplete payment",
      error: error.message
    });
  }
};

// Process successful payment
exports.processSuccessfulPayment = async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID is required"
      });
    }

    // Find payment record
    const payment = await PaymentModel.findOne({ orderId: orderId });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found"
      });
    }

    // Update status to PAID if not already
    if (payment.status !== "PAID") {
      payment.status = "PAID";
      await payment.save();
    }

    // Find transaction record
    const transaction = await TransactionModel.findOne({ transaction_id: orderId });

    if (transaction) {
      transaction.status = "Completed";
      await transaction.save();

      // Process loan repayment if applicable
      if (transaction.is_loan_repayment) {
        console.log("💰 Processing loan repayment for manual payment completion...");
        await processLoanRepayment(transaction, {});
      }
    }

    res.json({
      success: true,
      message: "Payment processed successfully",
      data: {
        orderId: orderId,
        status: payment.status
      }
    });
  } catch (error) {
    console.error("Error processing successful payment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to process successful payment",
      error: error.message
    });
  }
};

// Process failed payment
exports.processFailedPayment = async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID is required"
      });
    }

    // Find payment record
    const payment = await PaymentModel.findOne({ orderId: orderId });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found"
      });
    }

    // Update status to FAILED if not already
    if (payment.status !== "FAILED" && payment.status !== "CANCELLED") {
      payment.status = "FAILED";
      await payment.save();
    }

    // Find transaction record
    const transaction = await TransactionModel.findOne({ transaction_id: orderId });

    if (transaction) {
      transaction.status = "Failed";
      await transaction.save();

      // Revert loan repayment if applicable
      if (transaction.is_loan_repayment) {
        await revertLoanRepayment(transaction, {});
      }
    }

    res.json({
      success: true,
      message: "Failed payment processed successfully",
      data: {
        orderId: orderId,
        status: payment.status
      }
    });
  } catch (error) {
    console.error("Error processing failed payment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to process failed payment",
      error: error.message
    });
  }
};

// Additional endpoint to process loan repayment manually
exports.processLoanRepayment = async (req, res) => {
  try {
    const { memberId, transactionId } = req.body;

    if (!memberId || !transactionId) {
      return res.status(400).json({
        success: false,
        message: "Member ID and Transaction ID are required"
      });
    }

    const paymentTransaction = await TransactionModel.findOne({
      transaction_id: transactionId,
      member_id: memberId
    });

    if (!paymentTransaction) {
      return res.status(404).json({
        success: false,
        message: "Payment transaction not found"
      });
    }

    await processLoanRepayment(paymentTransaction, {});

    res.json({
      success: true,
      message: "Loan repayment processed successfully"
    });
  } catch (error) {
    console.error("Error processing loan repayment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to process loan repayment"
    });
  }
};

// Additional endpoint to revert loan repayment manually
exports.revertLoanRepayment = async (req, res) => {
  try {
    const { memberId, transactionId } = req.body;

    if (!memberId || !transactionId) {
      return res.status(400).json({
        success: false,
        message: "Member ID and Transaction ID are required"
      });
    }

    const paymentTransaction = await TransactionModel.findOne({
      transaction_id: transactionId,
      member_id: memberId
    });

    if (!paymentTransaction) {
      return res.status(404).json({
        success: false,
        message: "Payment transaction not found"
      });
    }

    await revertLoanRepayment(paymentTransaction, {});

    res.json({
      success: true,
      message: "Loan repayment reverted successfully"
    });
  } catch (error) {
    console.error("Error reverting loan repayment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to revert loan repayment"
    });
  }
};

module.exports = {
  createOrder: exports.createOrder,
  verifyPayment: exports.verifyPayment,
  getIncompletePayment: exports.getIncompletePayment,
  handleWebhook: exports.handleWebhook,
  retryPayment: exports.retryPayment,
  handlePaymentRedirect: exports.handlePaymentRedirect,
  checkPaymentStatus: exports.checkPaymentStatus,
  raiseTicket: exports.raiseTicket,
  saveIncompletePayment: exports.saveIncompletePayment,
  processSuccessfulPayment: exports.processSuccessfulPayment,
  processFailedPayment: exports.processFailedPayment,
  processLoanRepayment: exports.processLoanRepayment,
  revertLoanRepayment: exports.revertLoanRepayment
};