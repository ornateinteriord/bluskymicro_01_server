// ====================== Imports ======================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
require("dotenv").config()
const ImageKit = require("imagekit");
require("./models/db"); // Your Mongo DB connection file

// ====================== Routes ======================
const AuthRoutes = require("./routes/AuthRoutes");
const UserRoutes = require("./routes/UserRoutes");
const AdminRoutes = require("./routes/AdminRoute");
const PaymentRoutes = require("./routes/PaymentRoutes");
const KYCRoutes = require("./routes/KYCRoutes");
const CronRoutes = require("./routes/CronRoutes");
const AddOnPackageRoutes = require("./routes/AddOnPackageRoutes");
const ChatRoutes = require("./routes/ChatRoutes");

// NIDHI SPECIFIC ROUTES
const AgentRoutes = require("./routes/AgentRoute");
const NidhiMemberRoutes = require("./routes/NidhiMemberRoute");
const NidhiTransactionRoutes = require("./routes/NidhiTransactionRoute");
const ReceiptsRoutes = require("./routes/ReceiptsRoute");
const PaymentsRoutes = require("./routes/PaymentsRoute");
const CashTransactionRoutes = require("./routes/CashTransactionRoute");
const DebugRoutes = require("./routes/DebugRoute");



// 🔐 CASHFREE WEBHOOK CONTROLLER
const { handleWebhook } = require("./controllers/Payments/CashfreeController");
const connectDB = require("./models/db");
const { initCronJobs } = require("./cron/cron");
const { startMaturityScheduler } = require("./utils/maturityScheduler");


const app = express();
const server = http.createServer(app);

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('❌ Database Connection Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Database connection failed. Please try again.'
    });
  }
});

// ======================================================
//        🔌 SOCKET.IO SETUP
// ======================================================
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // Postman / server-to-server

      const isLocalhost = /^http:\/\/localhost:\d+$/.test(origin);
      const isNgrok = origin?.endsWith("ngrok-free.dev");
      const socketAllowedOrigins = [
        process.env.FRONTEND_URL,
        "https://www.BMSworld.club",
        "https://BMSworld.club",
        "https://BMS-worl-club.vercel.app",
        "https://blusky-microservices-ui.vercel.app",
        "https://bluskymicro01ui.vercel.app",
        "https://e-cash.in",
        "https://www.e-cash.in",
        "https://www.bluskymicroservices.com"
      ].filter(Boolean).map(o => o.replace(/\/$/, ""));

      const cleanOrigin = origin?.replace(/\/$/, "");
      if (isLocalhost || isNgrok || socketAllowedOrigins.includes(cleanOrigin) || socketAllowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`WebSocket CORS BLOCKED: ${origin}`));
    },
    credentials: true
  }
});

const activeUsers = new Map();
app.set("io", io);
app.set("activeUsers", activeUsers);

io.on("connection", (socket) => {
  console.log("🟢 User connected to WebSocket:", socket.id);

  const userId = socket.handshake.query?.userId;
  if (userId && userId !== "undefined") {
    if (!activeUsers.has(userId)) {
      activeUsers.set(userId, new Set());
    }
    activeUsers.get(userId).add(socket.id);
  }

  socket.on("joinRoom", ({ roomId }) => {
    socket.join(roomId);
    console.log(`📡 Socket ${socket.id} joined room ${roomId}`);
  });

  socket.on("typing", ({ roomId, isTyping }) => {
    socket.to(roomId).emit("userTyping", { userId: socket.id, isTyping });
  });

  socket.on("markAsRead", ({ roomId, messageIds }) => {
    socket.to(roomId).emit("messagesRead", { messageIds });
  });

  socket.on("disconnect", () => {
    console.log("🔴 User disconnected from WebSocket:", socket.id);
    if (userId && activeUsers.has(userId)) {
      activeUsers.get(userId).delete(socket.id);
      if (activeUsers.get(userId).size === 0) {
        activeUsers.delete(userId);
      }
    }
  });
});


// ======================================================
//        🛡️ CORS CONFIG (Supports Vite + ngrok)
// ======================================================
const allowedOrigins = [
  process.env.FRONTEND_URL,
  "https://BMS-worl-club.vercel.app",
  "https://www.BMSworld.club",
  "https://BMSworld.club",
  "https://blusky-microservices-ui.vercel.app",
  "https://bluskymicro01ui.vercel.app",
  "https://e-cash.in",
  "https://www.e-cash.in",
  "https://www.bluskymicroservices.com"
].filter(Boolean).map(o => o.replace(/\/$/, ""));

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // Postman / server-to-server

      const isLocalhost = /^http:\/\/localhost:\d+$/.test(origin);
      const isNgrok = origin.endsWith("ngrok-free.dev");
      const cleanOrigin = origin.replace(/\/$/, "");

      if (isLocalhost || isNgrok || allowedOrigins.includes(cleanOrigin) || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS BLOCKED: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);


app.options("*", cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const isLocalhost = /^http:\/\/localhost:\d+$/.test(origin);
    const isNgrok = origin.endsWith("ngrok-free.dev");
    const cleanOrigin = origin.replace(/\/$/, "");
    if (isLocalhost || isNgrok || allowedOrigins.includes(cleanOrigin) || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS BLOCKED: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// ======================================================
// ⚠️ IMPORTANT: RAW BODY FOR CASHFREE WEBHOOK
// ======================================================
app.use("/webhook/cashfree", express.raw({ type: "*/*" }));

// ======================================================
//        📦 BODY PARSER (normal APIs)
// ======================================================
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// ======================================================
// 💳 CASHFREE WEBHOOK ROUTE (must come AFTER raw body)
// ======================================================
app.post("/webhook/cashfree", handleWebhook);

// ======================================================
//    📷 ImageKit Configuration (Optional but Secure)
// ======================================================
let imagekit = null;

if (
  process.env.IMAGEKIT_PUBLIC_KEY &&
  process.env.IMAGEKIT_PRIVATE_KEY &&
  process.env.IMAGEKIT_URL_ENDPOINT
) {
  imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
  });
  console.log("🖼️ ImageKit initialized");
} else {
  console.warn("⚠️ ImageKit not initialized (missing .env values)");
}

app.get("/image-kit-auth", (_req, res) => {
  if (imagekit) {
    return res.send(imagekit.getAuthenticationParameters());
  }
  return res.status(500).json({ error: "ImageKit not configured" });
});

// ======================================================
//        📌 API ROUTES
// ======================================================
app.use("/auth", AuthRoutes);
app.use("/user", UserRoutes);
app.use("/admin", AdminRoutes);
app.use("/payments", PaymentRoutes);
app.use("/kyc", KYCRoutes);
app.use("/api/cron", CronRoutes);
app.use("/api/packages/addon", AddOnPackageRoutes);
app.use("/chat", ChatRoutes);

// NIDHI API MOUNTS
app.use("/transaction", NidhiTransactionRoutes);
app.use("/agent", AgentRoutes);
app.use("/member", NidhiMemberRoutes);
app.use("/banking", ReceiptsRoutes);
app.use("/banking", PaymentsRoutes);
app.use("/banking/cash-transactions", CashTransactionRoutes);
app.use("/debug", DebugRoutes);



// ======================================================
//        🏠 HOME
// ======================================================
app.get("/", (req, res) => {
  res.send(`🚀 ${process.env.PROJECT_NAME || "MSCS Server"} Running Securely`);
});

// ======================================================
//        🚀 Start Server
// ======================================================
const PORT = process.env.PORT || 5051;

const startServer = async () => {
  try {
    await connectDB();
    console.log("✅ MongoDB connected");

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`🌍 Server running on port ${PORT}`);
      console.log("🔔 Cashfree webhook ready");
      console.log("💬 WebSocket server ready");

      // Initialize Cron Jobs (Only for Local/VPS, Vercel uses Crons field)
      if (process.env.VERCEL !== "1") {
        initCronJobs();
        startMaturityScheduler();
      }
    });

  } catch (error) {
    console.error("❌ Server failed:", error.message);
    process.exit(1);
  }
};

// Start server (Vercel handles this differently)
if (process.env.VERCEL !== "1") {
  startServer();
} else {
  // For Vercel, just export the app
  module.exports = app;
}
