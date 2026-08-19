const mongoose = require("mongoose");

const participantDetailSchema = new mongoose.Schema(
    {
        memberId: { type: String, required: true },
        name: { type: String, default: "" },
        role: { type: String, default: "USER" },
        profileImage: { type: String, default: "" },
    },
    { _id: false }
);

const chatRoomSchema = new mongoose.Schema(
    {
        roomId: { type: String, required: true, unique: true, index: true },
        participants: [{ type: String }],
        participantDetails: [participantDetailSchema],
        lastMessage: { type: String, default: "" },
        lastMessageTime: { type: Date, default: null },
        unreadCount: { type: Map, of: Number, default: {} },
    },
    { timestamps: true }
);

module.exports = mongoose.model("ChatRoom", chatRoomSchema);
