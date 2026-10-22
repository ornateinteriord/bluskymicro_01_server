const crypto = require("crypto");
const mongoose = require("mongoose");
const Otp = require("../models/Otp");

// In-memory fallback and cache
let otpStore = {};

const generateOTP = (length = 6) => {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  const otp = crypto.randomInt(min, max + 1).toString();
  return otp;
};

/**
 * Stores an OTP with configurable validity (defaults to 10 minutes).
 * Clears any existing timeout for the identifier to prevent premature expiration bugs.
 * Persists to MongoDB so server restarts or nodemon file reloads do not destroy the OTP.
 */
const storeOTP = async (identifier, otp, expiryMinutes = 10) => {
  const cleanKey = String(identifier || "").trim();
  const cleanOtp = String(otp || "").trim();
  const expiryMs = expiryMinutes * 60 * 1000; // e.g. 10 minutes = 600,000ms
  const expiresAt = new Date(Date.now() + expiryMs);

  // 1. Clear any existing timer for this key to prevent race-condition deletions
  if (otpStore[cleanKey] && otpStore[cleanKey].timer) {
    clearTimeout(otpStore[cleanKey].timer);
  }

  // 2. Set new timeout for in-memory store
  const timer = setTimeout(() => {
    delete otpStore[cleanKey];
  }, expiryMs);

  otpStore[cleanKey] = {
    otp: cleanOtp,
    expiresAt,
    timer,
  };

  // 3. Persist to MongoDB (if connected)
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      await Otp.findOneAndUpdate(
        { identifier: cleanKey },
        { otp: cleanOtp, expiresAt },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (err) {
      console.error("⚠️ Failed to persist OTP to MongoDB:", err.message);
    }
  }
};

/**
 * Verifies an OTP against in-memory store and MongoDB fallback.
 * Automatically invalidates expired or already-used OTPs unless keepOTP is true.
 */
const verifyOTP = async (identifier, enteredOtp, keepOTP = false) => {
  const cleanKey = String(identifier || "").trim();
  const cleanOtp = String(enteredOtp || "").trim();

  if (!cleanKey || !cleanOtp) return false;

  // 1. Check in-memory store
  const memRecord = otpStore[cleanKey];
  if (memRecord) {
    const storedOtp = typeof memRecord === "object" ? memRecord.otp : memRecord;
    const expiresAt = typeof memRecord === "object" ? memRecord.expiresAt : null;

    if (expiresAt && new Date() > new Date(expiresAt)) {
      if (memRecord.timer) clearTimeout(memRecord.timer);
      delete otpStore[cleanKey];
    } else if (storedOtp === cleanOtp) {
      if (!keepOTP) {
        if (memRecord.timer) clearTimeout(memRecord.timer);
        delete otpStore[cleanKey];
        if (mongoose.connection && mongoose.connection.readyState === 1) {
          Otp.deleteOne({ identifier: cleanKey }).catch(() => {});
        }
      }
      return true;
    }
  }

  // 2. Fallback to MongoDB (if connected and nodemon restarted)
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const dbRecord = await Otp.findOne({
        identifier: cleanKey,
        expiresAt: { $gt: new Date() },
      });

      if (dbRecord && dbRecord.otp === cleanOtp) {
        if (!keepOTP) {
          await Otp.deleteOne({ _id: dbRecord._id });
          if (otpStore[cleanKey]?.timer) clearTimeout(otpStore[cleanKey].timer);
          delete otpStore[cleanKey];
        }
        return true;
      }
    } catch (error) {
      console.error("⚠️ MongoDB OTP verification error:", error.message);
    }
  }

  return false;
};

module.exports = { generateOTP, storeOTP, verifyOTP };