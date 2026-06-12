/**
 * index.js — PolyBettor Main Entry
 * Serves dashboard + full data API, runs sports or crypto bot by mode.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import * as state from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DRY_RUN = process.env.DRY_RUN !== "false";

app.use(express.json());
// NOTE: static is registered at the END of routes — otherwise public/index.html
// hijacks GET / and the dashboard's JSON polling breaks.

// ── UI log ring buffer (mirrors console) ────────────────────────
const uiLog = [];
const _log = console.log.bind(console), _err = console.error.bind(console);
function pushLog(type, args) {
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  let t = type;
  if (t === "info") {
    if (msg.includes("✅") || msg.includes("🟢")) t = "ok";
    else if (msg.includes("⚠️")) t = "warn";
    else if (msg.includes("❌") || msg.includes("🔴 LOSS")) t = "err";
  }
  uiLog.unshift({ ts: new Date().toISOString(), type: t, msg: msg.slice(0, 200) });
  if (uiLog.length > 200) uiLog.pop();
}
console.log = (...a) => { pushLog("info", a); _log(...a); };
console.error = (...a) => { pushLog("err", a); _err(...a); };

// ── Mode + last-scan cache ──────────────────────────────────────
let currentMode = process.env.BOT_MODE || "SPORTS"; // SPORTS | CRYPTO
let botModule = null;
let lastSignals = null;

const settings = {
  dryRun: DRY_RUN,
  sharpShooter: false,
  valueMode: process.env.VALUE_MODE === "true",
  autoMode: true,
  enabled: true,
};

console.log(`💰 State initialized | Balance: $${state.getDryBalance()} | Mode: ${currentMode} | ${DRY_RUN ? "DRY RUN" : "🔴 LIVE"}`);

// ── Helpers ─────────────────────────────────────────────────────
function fullStats() {
  const s = state.getStats() || {};
  const out = { ...s, dryBalance: state.getDryBalance() };
  if (out.winRate == null) {
    const total = (out.wins || 0) + (out.losses || 0);
    out.winRate = total > 0 ? ((out.wins / total) * 100).toFixed(1) + "%" : "N/A";
  }
  return out;
}
function allBets() {
  // state.js export name for history varies — try known options, fall back to active
  const fn = state.getAllBets || state.getBets || state.getBetHistory || state.getClosedAndActiveBets;
  try { if (fn) return fn() || []; } catch {}
  try { return state.getAllActiveBets() || []; } catch { return []; }
}

// ── Dashboard data API (paths the dashboard polls) ──────────────
app.get("/", (req, res) => {
  res.json({
    name: "PolyBettor",
    mode: currentMode,
    stats: fullStats(),
    settings,
    config: { bankroll: parseFloat(process.env.BANKROLL || "50") },
  });
});

app.get("/bets", (req, res) => res.json(allBets()));

app.get("/signals", (req, res) => {
  if (currentMode === "SPORTS" || !lastSignals) {
    return res.json({ bias: 0, confidence: 0, currentPrice: 0,
                      activeStrategy: currentMode === "SPORTS" ? "SPORTS_ML" : "—",
                      walls: {} });
  }
  res.json(lastSignals);
});

app.get("/markets", async (req, res) => {
  try {
    if (currentMode === "SPORTS") {
      const { fetchSportsMoneylines } = await import("./polymarket-us.js");
      const mkts = await fetchSportsMoneylines(); // 20s-cached internally
      return res.json(mkts.map(m => ({
        question: m.question,
        endDateIso: m.endIso || m.gameStartIso,
        _quality: m.ask || 0, // renders as the % column → favorite price
        _decision: {
          shouldBet: !!(m.ask && m.ask >= 0.52 && m.ask <= 0.95 && m.bid),
          side: "YES",
          edge: m.ask && m.bid ? Math.max(0, m.ask - m.bid) : 0, // spread shown in edge col
        },
      })));
    }
    res.json([]); // crypto markets are produced inside scan cycles; not re-fetched here
  } catch (e) {
    res.json([]);
  }
});

app.get("/log", (req, res) => res.json(uiLog));

app.post("/settings", (req, res) => {
  Object.assign(settings, req.body || {});
  console.log(`⚙ Settings updated: ${JSON.stringify(req.body)}`);
  res.json({ ok: true, settings });
});

// ── Dashboard page + mode switch + health ───────────────────────
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

app.get("/api/status", (req, res) => {
  const s = fullStats();
  res.json({
    mode: currentMode, dryRun: DRY_RUN,
    balance: s.dryBalance, activeBets: s.activeBets,
    totalBets: s.totalBets, wins: s.wins, losses: s.losses,
    pnl: s.pnl,
    winRate: s.totalBets > 0 ? ((s.wins / s.totalBets) * 100).toFixed(1) : "0",
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
  res.json({ mode: currentMode });
});

app.get("/health", (req, res) => res.json({ status: "ok", mode: currentMode }));

app.use(express.static("public")); // after routes so JSON endpoints win

app.listen(PORT, () => {
  console.log(`[OK] PolyBettor on port ${PORT} | ${currentMode} | dashboard at /dashboard`);
});

// ── Bot loader + scanner ────────────────────────────────────────
async function loadBotModule(mode) {
  try {
    botModule = mode === "SPORTS"
      ? await import("./bot-sports.js")
      : await import("./bot.js");
    console.log(`[INFO] Loaded ${mode === "SPORTS" ? "bot-sports.js" : "bot.js (crypto VALUE)"}`);
  } catch (err) {
    console.error("Bot load error:", err.message);
  }
}

(async () => {
  await loadBotModule(currentMode);
  setInterval(async () => {
    try {
      if (botModule?.runScanCycle) {
        const r = await botModule.runScanCycle();
        if (r?.signals) lastSignals = r.signals;
      }
    } catch (err) {
      console.error("Scan error:", err.message);
    }
  }, 8000);
  console.log("[INFO] Scanner started — every 8s");
})();
