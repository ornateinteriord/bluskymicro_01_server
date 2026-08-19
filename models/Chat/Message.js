const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
    {
        roomId: { type: String, required: true, index: true },
        senderId: { type: String, required: true },
        senderName: { type: String, default: "" },
        senderRole: { type: String, default: "USER" },
        recipientId: { type: String, default: "" },
        messageType: { type: String, enum: ["text", "image", "file", "audio"], default: "text" },
        text: { type: String, default: "" },
        imageUrl: { type: String, default: "" },
        fileName: { type: String, default: "" },
        fileSize: { type: Number, default: 0 },
        isRead: { type: Boolean, default: false },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);
