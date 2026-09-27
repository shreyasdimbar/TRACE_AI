require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const ingestRoutes = require("./routes/ingest");
const askRoutes = require("./routes/ask");
const documentsRoutes = require("./routes/documents");
const slackRoutes = require("./routes/slack");
const gmailRoutes = require("./routes/gmail");
const gdocsRoutes = require("./routes/gdocs");
const authRoutes = require("./routes/auth");

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/ingest", ingestRoutes);
app.use("/api/ask", askRoutes);
app.use("/api/documents", documentsRoutes);
app.use("/api/slack", slackRoutes);
app.use("/api/gdocs", gdocsRoutes);
app.use("/", gmailRoutes);

app.get("/", (req, res) => {
  res.json({
    status: "OrgMind API running 🚀",
    routes: [
      "POST /api/ingest",
      "POST /api/ask",
      "GET  /api/documents",
      "GET  /api/slack/channels",
      "POST /api/slack/fetch",
      "GET  /auth/google",
      "POST /api/gmail/fetch",
    ],
  });
});

// Connect MongoDB then start server
// Try to connect to configured MongoDB; fall back to in-memory MongoDB for dev
(async () => {
  const startServer = () => {
    app.listen(process.env.PORT || 5000, () => {
      console.log(
        `✅ Server running on http://localhost:${process.env.PORT || 5000}`,
      );
    });
  };

  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    console.log("✅ MongoDB connected");
    startServer();
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    console.log("ℹ️ Falling back to in-memory MongoDB for development...");
    try {
      const { MongoMemoryServer } = require("mongodb-memory-server");
      const mongod = await MongoMemoryServer.create();
      const uri = mongod.getUri();
      await mongoose.connect(uri);
      console.log("✅ Connected to in-memory MongoDB");
      startServer();
    } catch (memErr) {
      console.error("❌ Failed to start in-memory MongoDB:", memErr.message);
      process.exit(1);
    }
  }
})();
