const MessageModel = require("../../models/Chat/Message");
const ChatRoomModel = require("../../models/Chat/ChatRoom");
const MemberModel = require("../../models/Users/Member");
const AdminModel = require("../../models/Admin/Admin");

// ─── Get all chat rooms for logged-in user ────────────────────────────────────
const getRooms = async (req, res) => {
    try {
        const userId = req.user.memberId || req.user.Member_id || req.user.id;
        const userRole = (req.user.role || "").toUpperCase();
        let rooms;
        if (userRole === "ADMIN") {
            rooms = await ChatRoomModel.find({ participants: { $regex: /^ADMIN_/ } }).sort({ lastMessageTime: -1 }).lean();
        } else {
            rooms = await ChatRoomModel.find({ participants: userId }).sort({ lastMessageTime: -1 }).lean();
        }
        const roomsWithUnread = rooms.map((room) => {
            const unreadCount = userRole === "ADMIN" ? room.unreadCount?.["ADMIN_1"] || 0 : room.unreadCount?.[userId] || 0;
            return { ...room, unreadCount };
        });

        res.status(200).json({ success: true, data: roomsWithUnread });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to fetch chat rooms", error: error.message });
    }
};

// ─── Get messages for a room ──────────────────────────────────────────────────
const getMessages = async (req, res) => {
    try {
        const { roomId } = req.params;
        const userId = req.user.memberId || req.user.Member_id || req.user.id;
        const userRole = (req.user.role || "").toUpperCase();
        const limit = parseInt(req.query.limit) || 50;
        const skip = parseInt(req.query.skip) || 0;

        console.log(`[getMessages] Request for roomId: ${roomId}, userRole: ${userRole}, userId: ${userId}`);

        let query;
        if (roomId === "GLOBAL_BROADCAST") {
            query = { roomId };
        } else {
            let room = userRole === "ADMIN"
                ? await ChatRoomModel.findOne({ roomId, participants: { $regex: /^ADMIN_/ } })
                : await ChatRoomModel.findOne({ roomId, participants: userId });

            if (!room) {
                const participants = roomId.split('_');
                if (participants.includes(userId)) {
                    return res.status(200).json({ success: true, data: [] });
                }
                return res.status(403).json({ success: false, message: "Access denied to this chat room" });
            }

            if (roomId.includes("ADMIN_1")) {
                query = { $or: [{ roomId }, { roomId: "GLOBAL_BROADCAST" }] };
            } else {
                query = { roomId };
            }
        }

        const messages = await MessageModel.find(query)
            .sort({ createdAt: 1 }).skip(skip).limit(limit).lean();

        console.log(`[getMessages] Returning ${messages.length} messages`);
        res.status(200).json({ success: true, data: messages });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to fetch messages", error: error.message });
    }
};

// ─── Mark messages as read ────────────────────────────────────────────────────
const markAsRead = async (req, res) => {
    try {
        const { roomId } = req.params;
        const userId = req.user.memberId || req.user.Member_id || req.user.id;
        const userRole = (req.user.role || "").toUpperCase();

        let room = userRole === "ADMIN"
            ? await ChatRoomModel.findOne({ roomId, participants: { $regex: /^ADMIN_/ } })
            : await ChatRoomModel.findOne({ roomId, participants: userId });

        if (!room) {
            const participants = roomId.split('_');
            if (participants.includes(userId)) {
                return res.status(200).json({ success: true, message: "No room to mark as read" });
            }
            return res.status(403).json({ success: false, message: "Access denied" });
        }

        if (userRole === "ADMIN") {
            await MessageModel.updateMany({ roomId, recipientId: { $regex: /^ADMIN_/ }, isRead: false }, { $set: { isRead: true } });
            room.unreadCount.set("ADMIN_1", 0);
        } else {
            await MessageModel.updateMany({ roomId, recipientId: userId, isRead: false }, { $set: { isRead: true } });
            room.unreadCount.set(userId, 0);
        }
        await room.save();
        res.status(200).json({ success: true, message: "Messages marked as read" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to mark as read", error: error.message });
    }
};

// ─── Search member by mobile number ──────────────────────────────────────────
const searchMember = async (req, res) => {
    try {
        const { mobileNumber } = req.query;
        const userId = req.user.memberId || req.user.Member_id || req.user.id;

        if (!mobileNumber) return res.status(400).json({ success: false, message: "Mobile number is required" });

        const member = await MemberModel.findOne({
            $or: [
                { mobileno: mobileNumber },
                { contactno: mobileNumber },
                { mobile: mobileNumber },
                { phone: mobileNumber },
                { Mobile_Number: mobileNumber },
                { Member_id: mobileNumber },
                { member_id: mobileNumber },
            ],
        }).select("Member_id Name username mobileno contactno mobile phone profile_image role status");

        if (!member) {
            return res.status(404).json({ success: false, message: "No member found with this mobile number" });
        }

        if (member.Member_id === userId) return res.status(400).json({ success: false, message: "You cannot chat with yourself" });
        if (member.status?.toLowerCase() !== "active") return res.status(400).json({ success: false, message: `Member is not active (status: ${member.status})` });

        const participants = [userId, member.Member_id].sort();
        const roomId = participants.join("_");

        let chatRoom = await ChatRoomModel.findOne({ roomId });
        if (!chatRoom) {
            const currentUser = await MemberModel.findOne({ Member_id: userId });
            chatRoom = new ChatRoomModel({
                roomId, participants,
                participantDetails: [
                    { memberId: userId, name: currentUser?.Name || "Me", role: req.user.role || "USER", profileImage: currentUser?.profile_image || "" },
                    { memberId: member.Member_id, name: member.Name, role: member.role || "USER", profileImage: member.profile_image || "" },
                ],
                unreadCount: new Map(),
            });
            await chatRoom.save();
        }

        res.status(200).json({
            success: true,
            data: { member: { Member_id: member.Member_id, Name: member.Name, mobile: member.mobileno || member.contactno, profile_image: member.profile_image, role: member.role }, chatRoom },
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to search member", error: error.message });
    }
};

// ─── Send a message ───────────────────────────────────────────────────────────
const sendMessage = async (req, res) => {
    try {
        const { roomId, text, imageUrl, messageType, fileName, fileSize } = req.body;
        const userId = req.user.memberId || req.user.Member_id || req.user.id;
        const userRole = req.user.role;

        if (!roomId || (!text?.trim() && !imageUrl)) return res.status(400).json({ success: false, message: "Room ID and message content required" });

        let sender = await MemberModel.findOne({ Member_id: userId });
        let senderName = sender?.Name || "User", senderRole = userRole || "USER", senderId = userId;

        if (!sender && (userRole === "admin" || userRole === "ADMIN")) {
            const admin = await AdminModel.findById(req.user.id);
            if (admin) { senderName = admin.username || "Admin"; senderRole = "ADMIN"; senderId = "ADMIN_1"; sender = admin; }
        }
        if (!sender) return res.status(404).json({ success: false, message: "Sender not found" });

        let displayText = text?.trim() || (messageType === "image" ? "📷 Image" : messageType === "file" ? "📎 File" : "");

        let chatRoom = await ChatRoomModel.findOne({ roomId });
        if (!chatRoom) {
            // Auto-create room if it's a valid P2P room ID (sorted_ids)
            const parts = roomId.split('_');
            if (parts.length === 2) {
                const participants = parts.sort();
                const member1 = await MemberModel.findOne({ Member_id: participants[0] });
                const member2 = await MemberModel.findOne({ Member_id: participants[1] });

                chatRoom = new ChatRoomModel({
                    roomId,
                    participants,
                    participantDetails: [
                        { memberId: participants[0], name: member1?.Name || "User 1", role: member1?.role || "USER", profileImage: member1?.profile_image || "" },
                        { memberId: participants[1], name: member2?.Name || "User 2", role: member2?.role || "USER", profileImage: member2?.profile_image || "" },
                    ],
                    unreadCount: new Map(),
                });
                await chatRoom.save();
            } else {
                return res.status(404).json({ success: false, message: "Chat room not found" });
            }
        }

        chatRoom.lastMessage = displayText.substring(0, 100);
        chatRoom.lastMessageTime = new Date();

        const recipient = chatRoom.participants.find((p) => p !== senderId);
        if (recipient) {
            const currentCount = chatRoom.unreadCount.get(recipient) || 0;
            chatRoom.unreadCount.set(recipient, currentCount + 1);
        }
        await chatRoom.save();

        const message = await new MessageModel({ roomId, senderId, senderName, senderRole, recipientId: recipient || "", messageType: messageType || "text", text: text?.trim() || "", imageUrl: imageUrl || "", fileName: fileName || "", fileSize: fileSize || 0, isRead: false }).save();

        const io = req.app.get("io");
        const activeUsers = req.app.get("activeUsers");
        if (io) {
            io.to(roomId).emit("receiveMessage", { ...message.toJSON() });
            if (activeUsers && recipient) {
                const socketIds = activeUsers.get(recipient);
                console.log(`Backend emitting to recipient ${recipient}, socketIds: ${socketIds}`);
                if (socketIds && (socketIds.length > 0 || socketIds.size > 0)) {
                    socketIds.forEach(socketId => {
                        console.log(`Emitting new_message_notification to socketId: ${socketId}`);
                        io.to(socketId).emit("new_message_notification", { roomId, senderId, senderName, text: displayText.substring(0, 50) });
                    });
                } else {
                    console.log(`No active socketIds found for recipient ${recipient}`);
                }
            } else {
                console.log(`Missing activeUsers Map or recipient. recipient: ${recipient}`);
            }
        }
        res.status(201).json({ success: true, data: message });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to send message", error: error.message });
    }
};

// ─── Support chat ─────────────────────────────────────────────────────────────
const getSupportChat = async (req, res) => {
    try {
        const userId = req.user.memberId || req.user.Member_id || req.user.id;
        const adminId = "ADMIN_1";
        const participants = [userId, adminId].sort();
        const roomId = participants.join("_");

        let chatRoom = await ChatRoomModel.findOne({ roomId });
        if (!chatRoom) {
            const currentUser = await MemberModel.findOne({ Member_id: userId });
            if (!currentUser) return res.status(404).json({ success: false, message: "User not found" });
            chatRoom = new ChatRoomModel({
                roomId, participants,
                participantDetails: [
                    { memberId: userId, name: currentUser.Name, role: "USER", profileImage: currentUser.profile_image || "" },
                    { memberId: adminId, name: "Admin", role: "ADMIN", profileImage: "https://cdn-icons-png.flaticon.com/512/9322/9322127.png" },
                ],
                unreadCount: new Map(),
            });
            await chatRoom.save();
        }
        res.status(200).json({ success: true, data: chatRoom });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to connect to support", error: error.message });
    }
};

// ─── Delete a message ──────────────────────────────────────────────────────────
const deleteMessage = async (req, res) => {
    try {
        const { messageId } = req.params;

        const message = await MessageModel.findById(messageId);
        if (!message) {
            return res.status(404).json({ success: false, message: "Message not found" });
        }

        // Allow any user to delete the message as requested
        await MessageModel.findByIdAndDelete(messageId);

        const io = req.app.get("io");
        if (io) {
            io.to(message.roomId).emit("messageDeleted", { messageId, roomId: message.roomId });
        }

        res.status(200).json({ success: true, message: "Message deleted successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to delete message", error: error.message });
    }
};

module.exports = { getRooms, getMessages, markAsRead, searchMember, sendMessage, getSupportChat, deleteMessage };
