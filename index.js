/**
 * index.js — PolyBettor Main Entry
 * Dynamically loads bot-sports.js or bot.js based on MODE or dashboard switch
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import state from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// ── Serve dashboard ──
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// ── Global mode state ──
let currentMode = process.env.BOT_MODE || "SPORTS"; // SPORTS or CRYPTO
let botModule = null;

console.log(`💰 State initialized | Starting balance: $${state.getDryBalance()} | Mode: ${currentMode}`);
console.log(`[INFO] Scanner started — every 8s`);

const dryRun = process.env.DRY_RUN !== "false";
if (!dryRun) {
  console.log(`[INFO] TP: 6-14% | SL: 15% | Trail: 5%`);
}

// ── Dashboard API ──
app.get("/api/status", (req, res) => {
  const stats = state.getStats();
  const balance = state.getDryBalance();

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

app.post("/api/mode", async (req, res) => {
  const { mode } = req.body;
  if (!["SPORTS", "CRYPTO"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode. Use SPORTS or CRYPTO" });
  }
  
  currentMode = mode;
  await loadBotModule(mode);
  console.log(`🔄 Mode switched to: ${mode}`);
  res.json({ mode: currentMode, message: `Switched to ${mode} mode` });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", mode: currentMode });
});

app.listen(PORT, () => {
  console.log(`[OK] PolyBettor started on port ${PORT} | ${currentMode} mode`);
});

// ── Load appropriate bot ──
async function loadBotModule(mode) {
  try {
    if (mode === "SPORTS") {
      botModule = await import("./bot-sports.js");
      console.log("[INFO] Loaded bot-sports.js");
    } else {
      botModule = await import("./bot.js");
      console.log("[INFO] Loaded bot.js (crypto VALUE strategy)");
    }
  } catch (err) {
    console.error("Bot load error:", err.message);
  }
}

// ── Scanner loop ──
const startScanner = async () => {
  await loadBotModule(currentMode);

  setInterval(async () => {
    try {
      if (botModule && botModule.runScanCycle) {
        await botModule.runScanCycle();
      }
    } catch (err) {
      console.error("Scan error:", err.message);
    }
  }, 8000); // every 8s
};

startScanner();