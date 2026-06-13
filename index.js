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

// ── Live balance (real Polymarket account, SPORTS + LIVE only) ──
// Cached briefly so the dashboard's 3s poll doesn't hammer the signed API.
let _liveBalCache = { value: null, ts: 0 };
const LIVE_BAL_TTL = 10_000;
async function getLiveSportsBalance() {
  if (_liveBalCache.value != null && Date.now() - _liveBalCache.ts < LIVE_BAL_TTL) {
    return _liveBalCache.value;
  }
  try {
    const { getBuyingPower } = await import("./polymarket-us.js");
    const { currentBalance } = await getBuyingPower();
    _liveBalCache = { value: currentBalance, ts: Date.now() };
    return currentBalance;
  } catch {
    return _liveBalCache.value; // stale value (or null) on error
  }
}

// ── Helpers ─────────────────────────────────────────────────────
function allBets() {
  // state.js export name for history varies — try known options, fall back to active
  const fn = state.getAllBets || state.getBets || state.getBetHistory ||
             state.getRecentBets || state.getClosedAndActiveBets;
  try { if (fn) { const r = fn(); if (Array.isArray(r) && r.length) return r; } } catch {}
  try { return state.getAllActiveBets() || []; } catch { return []; }
}
const isSportsBet = b => b?.strategy === "SPORTS_ML";
function modeBets() {
  const all = allBets();
  return currentMode === "SPORTS" ? all.filter(isSportsBet) : all.filter(b => !isSportsBet(b));
}

// Open sports bets get live P&L from bot-sports' mark cache
function withLiveMarks(bets) {
  if (currentMode !== "SPORTS" || !botModule?.getSportsMarks) return bets;
  const marks = botModule.getSportsMarks();
  return bets.map(b => {
    if (b.status && b.status !== "open") return b;
    const mk = marks.get(b.marketConditionId);
    if (!mk) return b;
    const pct = (mk.movePct * 100).toFixed(1);
    return {
      ...b,
      pnl: mk.pnl, // dashboard row shows live $ instead of 'open'
      reasoning: `${b.reasoning || ""}  ⟂ LIVE ${(mk.price * 100).toFixed(0)}¢ (${mk.movePct >= 0 ? "+" : ""}${pct}%)`,
    };
  });
}

function fullStats() {
  const s = state.getStats() || {};
  const out = { ...s, dryBalance: state.getDryBalance() };

  // Scope W/L + P&L to the active mode when bet history is available
  const mine = modeBets();
  const closed = mine.filter(b => b.status && b.status !== "open");
  if (closed.length || ((s.wins || 0) + (s.losses || 0) === 0)) {
    out.wins = closed.filter(b => b.status === "won").length;
    out.losses = closed.filter(b => b.status === "lost").length;
    out.pnl = closed.reduce((a, b) => a + (Number(b.pnl) || 0), 0).toFixed(2);
    out.totalWagered = mine.reduce((a, b) => a + (Number(b.betSize) || 0), 0).toFixed(2);
    out.activeBets = mine.filter(b => !b.status || b.status === "open").length;
    out.totalBets = mine.length;
  }
  const total = (out.wins || 0) + (out.losses || 0);
  out.winRate = total > 0 ? ((out.wins / total) * 100).toFixed(1) + "%" : "N/A";
  return out;
}

// ── Dashboard data API (paths the dashboard polls) ──────────────
app.get("/", async (req, res) => {
  const stats = fullStats();

  // In LIVE sports mode, pull the real Polymarket account balance.
  if (currentMode === "SPORTS" && !settings.dryRun) {
    const liveBal = await getLiveSportsBalance();
    if (liveBal != null) stats.liveBalance = liveBal;
  }

  res.json({
    name: "PolyBettor",
    mode: currentMode,
    stats,
    settings,
    config: { bankroll: parseFloat(process.env.BANKROLL || "50") },
  });
});

app.get("/bets", (req, res) => res.json(withLiveMarks(modeBets())));

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
        _quality: m.ask ?? m.est ?? 0, // % column → favorite price (live or estimated)
        _decision: {
          shouldBet: (() => { const p = m.ask ?? m.est; return !!(p && p >= 0.52 && p <= 0.95); })(),
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
