/**
 * index.js — PolyBettor Main Entry
 * Dynamically loads bot-sports.js or bot.js based on MODE env var or dashboard setting
 */

import express from "express";
import state from "./state.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Global mode state (persisted to state.js) ──
let currentMode = process.env.BOT_MODE || "SPORTS"; // SPORTS or CRYPTO

console.log(`💰 State initialized | Starting balance: $${state.getDryBalance()} | Mode: ${currentMode}`);

// ── Dashboard API ──
app.get("/api/status", (req, res) => {
  const stats = state.getStats();
  const balance = state.getDryBalance();
  const dryRun = process.env.DRY_RUN !== "false";

  res.json({
    mode: currentMode,
    dryRun,
    balance,
    activeBets: stats.activeBets,
    totalBets: stats.totalBets,
    wins: stats.wins,
    losses: stats.losses,
    pnl: stats.pnl,
    winRate: stats.totalBets > 0 ? ((stats.wins / stats.totalBets) * 100).toFixed(1) : "0",
  });
});

app.post("/api/mode", (req, res) => {
  const { mode } = req.body;
  if (!["SPORTS", "CRYPTO"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode. Use SPORTS or CRYPTO" });
  }
  currentMode = mode;
  console.log(`🔄 Mode switched to: ${currentMode}`);
  res.json({ mode: currentMode, message: `Switched to ${currentMode} mode` });
});

app.get("/api/logs", (req, res) => {
  res.json({
    message: "Logs streaming to Railway console. Check dashboard at polymarket.us",
  });
});

// ── Health check ──
app.get("/health", (req, res) => {
  res.json({ status: "ok", mode: currentMode });
});

// ── Serve dashboard ──
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`[OK] PolyBettor started on port ${PORT} | Mode: ${currentMode}`);
});

// ── Load appropriate bot ──
const startBot = async () => {
  try {
    let botModule;

    if (currentMode === "SPORTS") {
      botModule = await import("./bot-sports.js");
      console.log("[INFO] Loaded bot-sports.js");
    } else {
      botModule = await import("./bot.js");
      console.log("[INFO] Loaded bot.js (crypto VALUE strategy)");
    }

    // Start scanner loop
    const scanInterval = setInterval(async () => {
      try {
        await botModule.runScanCycle();
      } catch (err) {
        console.error("Scan error:", err.message);
      }
    }, 8000); // every 8s

    console.log(`[INFO] Scanner started — every 8s | Mode: ${currentMode}`);
  } catch (err) {
    console.error("Bot load error:", err.message);
    process.exit(1);
  }
};

startBot();
