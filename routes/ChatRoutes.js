const express = require("express");
const router = express.Router();
const Authenticated = require("../middlewares/auth");
const ChatController = require("../controllers/Chat/ChatController");

router.use(Authenticated);

router.get("/rooms", ChatController.getRooms);
router.get("/messages/:roomId", ChatController.getMessages);
router.patch("/mark-read/:roomId", ChatController.markAsRead);
router.get("/search", ChatController.searchMember);
router.post("/message/send", ChatController.sendMessage);
router.delete("/message/:messageId", ChatController.deleteMessage);
router.get("/support", ChatController.getSupportChat);

module.exports = router;
