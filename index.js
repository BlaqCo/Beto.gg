/**
 * index.js — PolyBettor Server (Sports-only)
 * Strips all crypto/BTC logic. Runs bot-sports.js scan loop.
 * Exposes clean REST API for the dashboard.
 */

import express  from "express";
import dotenv   from "dotenv";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT          = parseInt(process.env.PORT           || "3000");
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_SECONDS || "15") * 1000;
const DRY_RUN       = process.env.DRY_RUN !== "false";

// ── System log ───────────────────────────────────────────────────────────────
const systemLog = [];
function addLog(type, msg) {
  systemLog.unshift({ ts: new Date().toISOString(), type, msg });
  if (systemLog.length > 300) systemLog.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ── Runtime state ─────────────────────────────────────────────────────────────
let lastMarkets  = [];
let lastScanResult = { exits: [], betsPlaced: 0, openPnl: 0 };
let isScanning   = false;
let botEnabled   = true;

// ── Dynamic imports (ES module) ───────────────────────────────────────────────
const { runScanCycle, getSportsMarks } = await import("./bot-sports.js");
const { getStats, getAllBets, getAllActiveBets, getDryBalance, recordScan } = await import("./state.js");
const { getBuyingPower, getOpenPositions, preflightUS } = await import("./polymarket-us.js");

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve dashboard
app.get("/dashboard", (_, res) => {
  try {
    res.setHeader("Content-Type", "text/html");
    res.send(readFileSync(join(__dirname, "dashboard.html"), "utf8"));
  } catch {
    res.status(404).send("dashboard.html not found");
  }
});

app.get("/health", (_, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// Root — bot status + stats
app.get("/", (_, res) => {
  const s = getStats();
  res.json({
    bot:     "PolyBettor Sports",
    mode:    DRY_RUN ? "DRY_RUN" : "LIVE",
    enabled: botEnabled,
    stats:   s,
    scanIntervalMs: SCAN_INTERVAL,
  });
});

// All bets (history)
app.get("/bets", (_, res) => res.json(getAllBets()));

// Active bets with live mark-to-market
app.get("/active", (_, res) => {
  const active = getAllActiveBets();
  const marks  = getSportsMarks();
  const result = active.map(b => {
    const slug = b.marketConditionId;
    const mark = marks.get(slug);
    return {
      ...b,
      currentPrice:  mark?.price   ?? null,
      openPnl:       mark?.pnl     ?? null,
      movePct:       mark?.movePct ?? null,
      markTs:        mark?.ts      ?? null,
    };
  });
  res.json(result);
});

// Markets list (last scan)
app.get("/markets", (_, res) => res.json(lastMarkets));

// Live markets only
app.get("/markets/live", (_, res) => res.json(lastMarkets.filter(m => m.isLive)));

// Balance endpoint
app.get("/balance", async (_, res) => {
  const s = getStats();
  if (DRY_RUN) {
    return res.json({
      buyingPower:    getDryBalance(),
      currentBalance: getDryBalance(),
      assetNotional:  0,
      mode:           "DRY_RUN",
      pnl:            parseFloat(s.pnl),
    });
  }
  try {
    const bal = await getBuyingPower();
    res.json({ ...bal, mode: "LIVE", pnl: parseFloat(s.pnl) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open positions (live mode only)
app.get("/positions", async (_, res) => {
  if (DRY_RUN) {
    // Simulate from active bets + marks
    const active = getAllActiveBets();
    const marks  = getSportsMarks();
    const result = {};
    for (const b of active) {
      const slug = b.marketConditionId;
      const mark = marks.get(slug);
      result[slug] = {
        netPosition:  Math.floor(b.betSize / b.entryPrice),
        cost:         b.betSize,
        cashValue:    mark ? mark.pnl + b.betSize : b.betSize,
        title:        b.marketQuestion || slug,
        outcome:      "YES",
        realized:     0,
      };
    }
    return res.json({ positions: result, mode: "DRY_RUN" });
  }
  try {
    const pos = await getOpenPositions();
    res.json({ positions: pos || {}, mode: "LIVE" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open P&L summary
app.get("/openPnl", (_, res) => {
  const marks = getSportsMarks();
  let total = 0;
  const breakdown = [];
  for (const [slug, mark] of marks) {
    total += mark.pnl || 0;
    breakdown.push({ slug, ...mark });
  }
  res.json({ totalOpenPnl: +total.toFixed(2), positions: breakdown });
});

// System log
app.get("/log", (_, res) => res.json(systemLog));

// Last scan result
app.get("/scan", (_, res) => res.json(lastScanResult));

// Bot control
app.post("/control", (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled === "boolean") {
    botEnabled = enabled;
    addLog(enabled ? "ok" : "warn", `Bot ${enabled ? "RESUMED" : "PAUSED"}`);
  }
  res.json({ ok: true, enabled: botEnabled });
});

// Manual preflight check
app.get("/preflight", async (_, res) => {
  if (DRY_RUN) return res.json({ ok: true, messages: ["DRY RUN — no auth needed"] });
  try {
    const result = await preflightUS();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, messages: [err.message] });
  }
});

app.listen(PORT, () => {
  addLog("ok", `PolyBettor Sports started on :${PORT} | ${DRY_RUN ? "DRY RUN" : "🔴 LIVE"} | scan every ${SCAN_INTERVAL / 1000}s`);
});

// ── Scan loop ──────────────────────────────────────────────────────────────────
async function scan() {
  if (!botEnabled || isScanning) return;
  isScanning = true;
  try {
    recordScan();
    const result = await runScanCycle();
    lastScanResult = result;
    if (result.markets?.length) lastMarkets = result.markets;

    if (result.betsPlaced > 0) {
      const s = getStats();
      addLog("ok", `PLACED ${result.betsPlaced} bet(s) | Active:${s.activeBets}/12 | P&L:$${s.pnl}`);
    }
    if (result.exits?.length > 0) {
      for (const e of result.exits) {
        addLog(e.pnl > 0 ? "ok" : "warn", `SETTLED ${e.pnl >= 0 ? "WIN" : "LOSS"} ${e.pnl >= 0 ? "+" : ""}$${Number(e.pnl).toFixed(2)} | ${(e.market || "").slice(0, 50)}`);
      }
    }
  } catch (err) {
    addLog("err", "Scan error: " + err.message);
  } finally {
    isScanning = false;
  }
}

// Run immediately then on interval
scan();
setInterval(scan, SCAN_INTERVAL);
addLog("info", `Scanner armed — every ${SCAN_INTERVAL / 1000}s | target 60–72¢ | $10 flat | 12 slots`);
