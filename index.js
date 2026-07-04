/**
 * index.js — PolyBettor Main Entry
 * Serves dashboard + full data API.
 *
 * ARCHITECTURE CHANGE: previously "mode" controlled which bot's scan loop
 * ran — switching to CRYPTO meant SPORTS positions got zero monitoring
 * (and vice versa). Now BOTH bot-sports.js and bot.js run independent scan
 * loops at all times. "Mode" is purely a DASHBOARD VIEW toggle — it picks
 * which board/markets/stats are shown, but never starts or stops trading.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import * as state from "./state.js";
import {
  getBuyingPower,
  getOpenPositions,
  getBBO,
  fetchSportsMoneylines,
  getOpenPositionsEnriched,
  getTradeHistory,
} from "./polymarket-us.js";

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
  if (uiLog.length > 500) uiLog.pop();
}
console.log = (...a) => { pushLog("info", a); _log(...a); };
console.error = (...a) => { pushLog("err", a); _err(...a); };

// ── Dashboard view mode (display-only — does NOT start/stop bots) ──
let currentMode = process.env.BOT_MODE || "SPORTS"; // SPORTS | CRYPTO
let sportsBot = null;
let cryptoBot = null;
let lastSignals = null;

const settings = {
  dryRun: DRY_RUN,
  sharpShooter: false,
  valueMode: process.env.VALUE_MODE === "true",
  autoMode: true,
  enabled: true,
};

console.log(`💰 State initialized | Balance: $${state.getDryBalance()} | View: ${currentMode} | ${DRY_RUN ? "DRY RUN" : "🔴 LIVE"}`);

// ── Live balance (real Polymarket account, LIVE only) ───────────
// Cached briefly so the dashboard's 3s poll doesn't hammer the signed API.
let _liveBalCache = { value: null, ts: 0 };
const LIVE_BAL_TTL = 10_000;
async function getLiveSportsBalance() {
  if (_liveBalCache.value != null && Date.now() - _liveBalCache.ts < LIVE_BAL_TTL) {
    return _liveBalCache.value;
  }
  try {
    
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
function betsForMode(mode) {
  const all = allBets();
  return mode === "SPORTS" ? all.filter(isSportsBet) : all.filter(b => !isSportsBet(b));
}

// Open sports bets get live P&L from bot-sports' mark cache (always loaded now)
function withSportsLiveMarks(bets) {
  if (!sportsBot?.getSportsMarks) return bets;
  const marks = sportsBot.getSportsMarks();
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

// ── Real-time Polymarket portfolio mark-to-market ───────────────
// Fetches live positions from /v1/portfolio/positions + current BBO bids
// to compute exact open P/L against each bet's entry price.
// Cached 15s so every dashboard poll (3s) doesn't spam signed API.
let _portfolioCache = { positions: null, ts: 0 };
const PORTFOLIO_TTL = 15_000;

async function getLivePortfolioPnl() {
  if (!settings.dryRun && Date.now() - _portfolioCache.ts < PORTFOLIO_TTL && _portfolioCache.positions) {
    return _portfolioCache.positions;
  }
  if (settings.dryRun) return null; // dry run — no real account to query

  try {
    
    const positions = await getOpenPositions();
    if (!positions) return null;

    // For each open position, fetch current BBO bid to mark-to-market
    const slugs = Object.keys(positions).filter(s => positions[s].qtyBought > 0);
    const bboResults = await Promise.allSettled(
      slugs.map(async slug => {
        const bbo = await getBBO(slug);
        return { slug, bid: bbo?.bid ?? bbo?.last ?? null };
      })
    );

    const liveMarks = {}; // slug → { bid, qtyBought }
    for (const r of bboResults) {
      if (r.status === "fulfilled" && r.value.bid) {
        const { slug, bid } = r.value;
        liveMarks[slug] = { bid, qtyBought: positions[slug].qtyBought };
      }
    }

    // Match against our local bet records to get entry prices
    const allBets = state.getAllBets ? state.getAllBets() : [];
    const openBets = allBets.filter(b => !b.status || b.status === "open");

    let totalOpenPnl = 0;
    let portfolioValue = 0; // current market value of all open positions
    const betMarks = {}; // conditionId → { pnl, currentValue, bid, entryPrice }

    for (const bet of openBets) {
      const slug = bet.marketConditionId;
      const mark = liveMarks[slug];
      if (!mark || !bet.entryPrice || !bet.betSize) continue;

      const shares = bet.betSize / bet.entryPrice;
      const currentValue = shares * mark.bid;
      const openPnl = currentValue - bet.betSize;
      totalOpenPnl += openPnl;
      portfolioValue += currentValue;
      betMarks[slug] = {
        pnl: parseFloat(openPnl.toFixed(2)),
        currentValue: parseFloat(currentValue.toFixed(2)),
        bid: mark.bid,
        entryPrice: bet.entryPrice,
        movePct: (mark.bid - bet.entryPrice) / bet.entryPrice,
      };
    }

    const result = {
      totalOpenPnl: parseFloat(totalOpenPnl.toFixed(2)),
      portfolioValue: parseFloat(portfolioValue.toFixed(2)),
      betMarks,
      slugCount: slugs.length,
      ts: Date.now(),
    };

    _portfolioCache = { positions: result, ts: Date.now() };
    return result;
  } catch (err) {
    console.error("⚠️ Portfolio mark-to-market failed:", err.message);
    return _portfolioCache.positions; // return stale on error
  }
}

// Generic per-mode stat block: realized P&L, W/L, active count, wagered.
async function statsForMode(mode, portfolio) {
  const mine = betsForMode(mode);
  const closed = mine.filter(b => b.status && b.status !== "open");
  const open = mine.filter(b => !b.status || b.status === "open");
  const wins = closed.filter(b => b.status === "won").length;
  const losses = closed.filter(b => b.status === "lost").length;
  const realizedPnl = closed.reduce((a, b) => a + (Number(b.pnl) || 0), 0);
  const totalWagered = mine.reduce((a, b) => a + (Number(b.betSize) || 0), 0);
  const total = wins + losses;

  let openPnl = 0;

  if (mode === "SPORTS") {
    if (portfolio?.betMarks && Object.keys(portfolio.betMarks).length > 0) {
      // ★ Use real Polymarket position values (LIVE mode)
      for (const b of open) {
        const mark = portfolio.betMarks[b.marketConditionId];
        if (mark) openPnl += mark.pnl;
      }
    } else if (sportsBot?.getSportsMarks) {
      // Fallback: use scan-loop BBO cache (dry run or portfolio unavailable)
      const marks = sportsBot.getSportsMarks();
      for (const b of open) {
        const mk = marks.get(b.marketConditionId);
        if (mk) openPnl += Number(mk.pnl) || 0;
      }
    }
  }

  return {
    wins, losses,
    pnl: realizedPnl.toFixed(2),
    openPnl: openPnl.toFixed(2),
    totalPnl: (realizedPnl + openPnl).toFixed(2),
    totalWagered: totalWagered.toFixed(2),
    activeBets: open.length,
    totalBets: mine.length,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(1) + "%" : "N/A",
  };
}

async function fullStats(portfolio) {
  const s = state.getStats() || {};
  const sports = await statsForMode("SPORTS", portfolio);
  const crypto = await statsForMode("CRYPTO", portfolio);

  const out = {
    ...s,
    dryBalance: state.getDryBalance(),
    sports,
    crypto,
    // Expose portfolio-level data for dashboard
    portfolioValue: portfolio?.portfolioValue ?? null,
    portfolioOpenPnl: portfolio?.totalOpenPnl ?? null,
  };

  // Legacy top-level fields scoped to current view
  const active = currentMode === "SPORTS" ? sports : crypto;
  out.wins = active.wins;
  out.losses = active.losses;
  out.pnl = active.pnl;
  out.totalWagered = active.totalWagered;
  out.activeBets = active.activeBets;
  out.totalBets = active.totalBets;
  out.winRate = active.winRate;

  return out;
}

// ── Dashboard data API (paths the dashboard polls) ──────────────
app.get("/", async (req, res) => {
  // Fetch real portfolio mark-to-market and live balance in parallel
  const [portfolio, liveBal] = await Promise.all([
    getLivePortfolioPnl(),
    settings.dryRun ? Promise.resolve(null) : getLiveSportsBalance(),
  ]);

  const stats = await fullStats(portfolio);
  if (liveBal != null) stats.liveBalance = liveBal;

  // Expose portfolio value directly on stats for the dashboard P/L curve
  if (portfolio) {
    stats.portfolioValue = portfolio.portfolioValue;
    stats.portfolioOpenPnl = portfolio.totalOpenPnl;
    stats.portfolioTs = portfolio.ts;
  }

  res.json({
    name: "PolyBettor",
    mode: currentMode,
    stats,
    settings,
    config: { bankroll: parseFloat(process.env.BANKROLL || "50") },
  });
});

app.get("/bets", (req, res) => {
  const bets = betsForMode(currentMode);
  res.json(currentMode === "SPORTS" ? withSportsLiveMarks(bets) : bets);
});

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

// ── Dashboard page + view switch + health ───────────────────────
app.get("/landing", (req, res) => res.sendFile(path.join(__dirname, "landing.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/octopus.svg", (req, res) => res.sendFile(path.join(__dirname, "octopus.svg")));
app.get("/octopus.png", (req, res) => res.sendFile(path.join(__dirname, "octopus.png")));

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

// View switch — DISPLAY ONLY. Both bots keep running regardless.
app.post("/api/mode", async (req, res) => {
  const { mode } = req.body;
  if (!["SPORTS", "CRYPTO"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode. Use SPORTS or CRYPTO" });
  }
  currentMode = mode;
  console.log(`🔄 Dashboard view switched to: ${mode} (both bots continue running)`);
  res.json({ mode: currentMode });
});

// ── /api/positions — real open positions from Polymarket ───────────
// In DRY mode: falls back to state.js active bets.
// In LIVE mode: pulls directly from /v1/portfolio/positions + live BBO.
let _posCache = { data: null, ts: 0 };
app.get("/api/positions", async (req, res) => {
  if (!DRY_RUN) {
    // Cache 10s so dashboard's 3s poll doesn't hammer signed API
    if (_posCache.data && Date.now() - _posCache.ts < 5_000) {
      return res.json(_posCache.data);
    }
    try {
      const stateBets = state.getAllBets ? state.getAllBets() : [];

      // Build entry price cache from trade activities (keyed by marketSlug)
      // Use ONLY cached data — never trigger a fresh fetch here to avoid 429
      const entryPriceCache = {};
      try {
        const acts = _histCache.data; // only use cache, no fresh fetch
        if (acts && acts.length) {
          acts.filter(a => a._type === "trade" && a.price && a.price > 0.05
                        && (a.side === "BUY" || a.side === "" || !a.side))
              .forEach(a => {
                if (a.marketSlug && !entryPriceCache[a.marketSlug]) {
                  entryPriceCache[a.marketSlug] = a.price;
                }
              });
          const n = Object.keys(entryPriceCache).length;
          if (n > 0) console.log(`📊 Entry price cache: ${n} slugs from ${acts.length} activities`);
        }
      } catch(e) {
        // Non-fatal — positions still show, just without entry price
      }

      const positions = await getOpenPositionsEnriched(stateBets, entryPriceCache);
      _posCache = { data: positions, ts: Date.now() };
      return res.json(positions);
    } catch (e) {
      console.error("⚠️ /api/positions error:", e.message);
    }
  }
  // DRY fallback: return state.js active bets shaped like position objects
  const bets = (state.getAllBets ? state.getAllBets() : [])
    .filter(b => b.status === "open" && b.strategy === "SPORTS_ML");
  const marks = sportsBot?.getSportsMarks?.() || new Map();
  const out = bets.map(b => {
    const mk = marks.get(b.marketConditionId);
    return {
      slug:        b.marketConditionId,
      question:    (b.marketQuestion || "").replace(/^\[.*?\]\s*/, ""),
      category:    b.entryCoin || "",
      qty:         b.betSize / (b.entryPrice || 1),
      avgPrice:    b.entryPrice,
      currentBid:  mk?.price ?? b.entryPrice,
      costBasis:   +b.betSize.toFixed(2),
      currentVal:  mk ? +(mk.price * b.betSize / (b.entryPrice || 1)).toFixed(2) : null,
      openPnl:     mk?.pnl ?? null,
      side:        "YES",
      placedAt:    b.placedAt,
    };
  });
  res.json(out);
});

// ── /api/history — merged: state.js closed bets + Polymarket activities ──
// State.js closed bets are ALWAYS included (reliable for this session).
// Activities from /v1/portfolio/activities fill in cross-session history.
let _histCache = { data: null, ts: 0 };
app.get("/api/history", async (req, res) => {
  try {
    // Source 1: state.js closed bets (always reliable)
    const stateClosed = (state.getAllBets ? state.getAllBets() : [])
      .filter(b => b.status && b.status !== "open")
      .map(b => ({
        _type:       b.status === "won" ? "resolution" : b.status === "lost" ? "resolution" : "trade",
        _source:     "state",
        marketSlug:  b.marketConditionId,
        question:    (b.marketQuestion || "").replace(/^\[.*?\]\s*/, ""),
        realizedPnl: parseFloat(b.pnl || 0),
        costBasis:   parseFloat(b.betSize || 0),
        price:       b.entryPrice || null,
        createTime:  b.closedAt || b.placedAt || "",
        won:         b.status === "won",
        side:        "BUY",
      }));

    // Source 2: Polymarket activities (fills cross-session history)
    let actActs = [];
    if (!DRY_RUN) {
      if (_histCache.data && Date.now() - _histCache.ts < 10_000) {
        actActs = _histCache.data;
      } else {
        try {
          actActs = await getTradeHistory({ limit: 500 });
          if (actActs.length) _histCache = { data: actActs, ts: Date.now() };
        } catch(e) {
          console.error("⚠️ /api/history activities fetch:", e.message);
        }
      }
    }

    // Merge: deduplicate by question text (state bets take priority)
    const stateQuestions = new Set(stateClosed.map(b => b.question?.slice(0,30)));
    const actFiltered = actActs.filter(a => {
      const q = (a.question || a.marketSlug || "").slice(0,30);
      return !stateQuestions.has(q); // don't duplicate what state already has
    });

    const merged = [...stateClosed, ...actFiltered]
      .sort((a,b) => (b.createTime||"") > (a.createTime||"") ? 1 : -1);

    return res.json(merged);
  } catch(e) {
    console.error("⚠️ /api/history error:", e.message);
    return res.json([]);
  }
});

// ── /api/stats — P/L, W/L, wagered from BOTH activities + state ──
// State.js is authoritative for bets placed THIS session.
// Activities endpoint fills in history across sessions.
// We merge both and take the max to handle restarts gracefully.
let _statsCache = { data: null, ts: 0 };
app.get("/api/stats", async (req, res) => {
  if (_statsCache.data && Date.now() - _statsCache.ts < 60_000) {
    return res.json(_statsCache.data);
  }
  try {
    // ── Source 1: state.js (always reliable for current session) ──
    const allBetsArr = state.getAllBets ? state.getAllBets() : [];
    const closed = allBetsArr.filter(b => b.status && b.status !== "open");
    const stateWins   = closed.filter(b => b.status === "won").length;
    const stateLosses = closed.filter(b => b.status === "lost").length;
    const statePnl    = closed.reduce((s,b) => s + parseFloat(b.pnl||0), 0);
    const stateWaged  = allBetsArr.reduce((s,b) => s + parseFloat(b.betSize||0), 0);
    const stateBets   = allBetsArr.length;

    // ── Source 2: Polymarket activities endpoint ────────────────
    let actWins=0, actLosses=0, actPnl=0, actWaged=0, actBets=0;
    if (!DRY_RUN) {
      try {
        let acts = _histCache.data;
        if (!acts || Date.now() - _histCache.ts > 300_000) {
          acts = await getTradeHistory({ limit: 500 });
          if (acts && acts.length) _histCache = { data: acts, ts: Date.now() };
        }
        if (acts && acts.length) {
          const trades      = acts.filter(a => a._type === "trade");
          const resolutions = acts.filter(a => a._type === "resolution");

          // Debug: log what we got
          console.log(`📊 Stats: ${acts.length} total acts | ${trades.length} trades | ${resolutions.length} resolutions`);
          if (trades.length > 0) {
            const sample = trades[0];
            console.log(`📊 Trade sample: slug=${sample.marketSlug?.slice(0,25)} side=${sample.side} price=${sample.price} cost=${sample.costBasis} pl=${sample.realizedPnl}`);
          }
          if (resolutions.length > 0) {
            console.log(`📊 Resolution sample: ${resolutions[0].question?.slice(0,40)} won=${resolutions[0].won} pl=${resolutions[0].realizedPnl}`);
          }

          // BUY trades = bets placed (side=BUY or empty, cost>0)
          const buys = trades.filter(a => {
            const s = (a.side||"").toUpperCase();
            return s === "BUY" || (s === "" && parseFloat(a.costBasis||0) > 0);
          });
          actWins   = resolutions.filter(a => a.won).length;
          actLosses = resolutions.filter(a => !a.won && parseFloat(a.realizedPnl||0) < 0).length;
          actPnl    = resolutions.reduce((s,a) => s + parseFloat(a.realizedPnl||0), 0)
                    + trades.reduce((s,a) => s + parseFloat(a.realizedPnl||0), 0);
          actWaged  = buys.reduce((s,a) => s + parseFloat(a.costBasis||0), 0);
          actBets   = buys.length;
          console.log(`📊 Stats computed: wins=${actWins} losses=${actLosses} pnl=${actPnl.toFixed(2)} waged=${actWaged.toFixed(2)} bets=${actBets}`);
        } else {
          console.log("📊 Stats: no activities returned from getTradeHistory");
        }
      } catch(e) {
        console.error("⚠️ activities fetch in /api/stats:", e.message);
      }
    }

    // ── Merge: take whichever source has more data ──────────────
    const wins        = Math.max(stateWins, actWins);
    const losses      = Math.max(stateLosses, actLosses);
    const totalPnl    = actPnl !== 0 ? +actPnl.toFixed(2) : +statePnl.toFixed(2);
    const totalWagered= actWaged > 0 ? +actWaged.toFixed(2) : +stateWaged.toFixed(2);
    const totalBets   = Math.max(stateBets, actBets);

    const stats = { wins, losses, totalPnl, totalWagered, totalBets };
    _statsCache = { data: stats, ts: Date.now() };
    return res.json(stats);
  } catch(e) {
    console.error("⚠️ /api/stats error:", e.message);
    // Emergency fallback — raw state
    const s = state.getStats ? state.getStats() : {};
    return res.json({
      wins: s.wins||0, losses: s.losses||0,
      totalPnl: parseFloat(s.pnl||0),
      totalWagered: parseFloat(s.totalWagered||0),
      totalBets: s.betsPlaced||0,
    });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", view: currentMode }));

app.use(express.static("public")); // after routes so JSON endpoints win

app.listen(PORT, () => {
  console.log(`[OK] PolyBettor on port ${PORT} | view: ${currentMode} | dashboard at /dashboard`);
});

// ── Bot loaders + independent scanners ───────────────────────────
async function loadBots() {
  try {
    const botMod = await import("./bot-sports.js");
    sportsBot = botMod;
    console.log("[INFO] Loaded bot-sports.js");
  } catch (err) {
    console.error("Sports bot load error:", err.message);
  }
  // Crypto bot disabled — not legal in California
  console.log("[INFO] Crypto bot disabled (CA regulations)");
}

(async () => {
  await state.ready;
  await loadBots();

  // ── Load bet history into log on boot (LIVE mode only) ──────────
  // Fetches /v1/portfolio/trades and pushes each trade into the UI log
  // so the System Log panel shows your full bet history immediately.
  if (!DRY_RUN) {
    try {
      const trades = await getTradeHistory({ limit: 500 });
      if (trades.length) {
        // Log raw shape of first trade so we know field names
        console.log(`📋 Trade history shape: ${JSON.stringify(trades[0]).slice(0, 300)}`);

        // Log a summary line per trade, newest first
        const sorted = [...trades].sort((a, b) => {
          const da = a.createdAt || a.created_at || "";
          const db = b.createdAt || b.created_at || "";
          return db > da ? 1 : -1;
        });
        console.log(`📋 BET HISTORY — ${sorted.length} trades loaded`);
        sorted.forEach(a => {
          if (a._type === "resolution") {
            const won = a.won;
            const pl  = (a.realizedPnl ?? 0).toFixed(2);
            const result = won ? "✅ WIN" : "❌ LOSS";
            const ts  = (a.createTime || "").slice(0, 10) || "—";
            console.log(`  ${result} | ${ts} | P/L $${pl} | ${a.question || a.marketSlug}`);
          } else if (a._type === "trade") {
            const pl  = (a.realizedPnl ?? 0).toFixed(2);
            const cost = (a.costBasis ?? 0).toFixed(2);
            const result = parseFloat(pl) > 0 ? "✅ WIN" : parseFloat(pl) < 0 ? "❌ LOSS" : "🔄 TRADE";
            const ts  = (a.createTime || "").slice(0, 10) || "—";
            console.log(`  ${result} | ${ts} | $${cost} @ ${a.price ? Math.round(a.price*100)+"¢" : "—"} | P/L $${pl} | ${a.question || a.marketSlug}`);
          }
        });
        // Cache for /api/history so first dashboard poll is instant
        _histCache = { data: trades, ts: Date.now() };
      } else {
        console.log("📋 No trade history found on Polymarket account");
      }
    } catch (err) {
      console.error("⚠️ Boot trade history load failed:", err.message);
    }

    // Load open positions on boot + reconcile with state.js
    // This fixes the case where bets exist on Polymarket but state was reset
    try {
      const stateBetsB = state.getAllBets ? state.getAllBets() : [];
      const positions = await getOpenPositionsEnriched(stateBetsB, {});
      if (positions.length) {
        console.log(`📊 OPEN POSITIONS — ${positions.length} active`);

        // Reconcile: if a position exists on Polymarket but NOT in state, record it
        const stateIds = new Set((state.getAllBets ? state.getAllBets() : [])
          .filter(b => b.status === "open")
          .map(b => b.marketConditionId));

        let reconciled = 0;
        for (const p of positions) {
          const slug = p.slug;
          const q    = (p.question || slug || "Unknown").slice(0, 50);
          const cost = p.costBasis != null ? "$" + p.costBasis.toFixed(2) : "—";
          const bid  = p.currentBid ? Math.round(p.currentBid * 100) + "¢" : "—";
          const pnl  = p.openPnl != null ? (p.openPnl >= 0 ? "+" : "") + p.openPnl.toFixed(2) : "—";
          const prob = p.avgPrice  ? Math.round(p.avgPrice * 100) + "%" : "—";
          console.log(`  🔴 LIVE | ${cost} @ ${prob} | now ${bid} | P/L $${pnl} | ${q}`);

          // If not in state, inject it so settlement tracking works
          if (!stateIds.has(slug) && state.recordBet) {
            try {
              state.recordBet({
                market: {
                  conditionId: slug,
                  question:    p.question || slug,
                  endDateIso:  null,
                },
                side:               "YES",
                betSize:            p.costBasis || 0,
                edge:               0,
                trueProbability:    p.avgPrice || 0.65,
                impliedProbability: p.avgPrice || 0.65,
                entryPrice:         p.avgPrice || null,
                strategy:           "SPORTS_ML",
                entryCoin:          p.category || "SPORT",
                reasoning:          "Reconciled from Polymarket on boot",
              });
              reconciled++;
              console.log(`  ♻️ Reconciled into state: ${slug.slice(0, 40)}`);
            } catch(re) {
              console.error("  ⚠️ Reconcile failed:", re.message);
            }
          }
        }
        if (reconciled > 0) console.log(`📊 Reconciled ${reconciled} Polymarket positions into state`);
        _posCache = { data: positions, ts: Date.now() };
      } else {
        console.log("📊 No open positions on Polymarket");
      }
    } catch (err) {
      console.error("⚠️ Boot positions load failed:", err.message);
    }
  }

  // Sports scanner — 3s interval
  let scanCount = 0;
  setInterval(async () => {
    try {
      scanCount++;
      if (scanCount % 10 === 1) console.log(`[DEBUG] Sports scan cycle #${scanCount} — sportsBot loaded: ${!!sportsBot}, has runScanCycle: ${!!(sportsBot?.runScanCycle)}`);
      if (sportsBot?.runScanCycle) {
        await sportsBot.runScanCycle();
      } else {
        if (scanCount === 1) console.error("[ERROR] sportsBot not loaded or runScanCycle not found");
      }
    } catch (err) {
      console.error("Sports scan error:", err.message, err.stack?.split('\n')[1]);
    }
  }, 3000);

  console.log("[INFO] Sports scanner started — crypto disabled (CA)");
})();
