const mongoose = require("mongoose");

const OtpSchema = new mongoose.Schema(
  {
    identifier: {
      type: String,
      required: true,
      index: true,
    },
    otp: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
  },
  { timestamps: true }
);

const Otp = mongoose.models.Otp || mongoose.model("Otp", OtpSchema);

module.exports = Otp;
