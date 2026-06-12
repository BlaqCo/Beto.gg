/**
 * bot-sports.js — PolyBettor Sports Edition
 * 
 * Moneyline favorites only. Scan all Polymarket sports.
 * $10-15 straight bets on favorites, hold to expiry.
 * TP: 6-14%, SL: 15% drawdown, trail 5%.
 */

import state from "./state.js";

const botSettings = {
  enabled: true,
  dryRun: process.env.DRY_RUN !== "false",
  valueMode: false, // sports are straightforward, no value calc needed
};

// ── Sports Moneyline Config ──
const SPORTS_CONFIG = {
  moneylineOnly: true,
  favoriteThreshold: 0.60, // YES price ≤ 60¢ = favorite
  minLiquidity: 100, // min order book depth
  sportSeries: [
    // NFL
    { pattern: /NFL.*Moneyline|NFL.*winner/i, sport: "NFL", league: "KXNFL" },
    // NBA
    { pattern: /NBA.*Moneyline|NBA.*winner/i, sport: "NBA", league: "KXNBA" },
    // MLB
    { pattern: /MLB.*Moneyline|MLB.*winner/i, sport: "MLB", league: "KXMLB" },
    // MLS
    { pattern: /MLS.*Moneyline|MLS.*winner/i, sport: "MLS", league: "KXMLS" },
    // Other: soccer, tennis, etc. (Polymarket.us may have these)
    { pattern: /Premier League|EPL.*winner/i, sport: "EPL", league: null },
    { pattern: /Champions League|CL.*winner/i, sport: "CL", league: null },
    { pattern: /Tennis.*winner|ATP|WTA/i, sport: "Tennis", league: null },
  ],
};

const BET_CONFIG = {
  minBet: 10,
  maxBet: 15,
  betSize: 12, // middle ground
  tp: { min: 0.06, max: 0.14 }, // 6-14% profit target
  sl: 0.15, // 15% stop loss (absolute)
  trail: 0.05, // 5% trailing stop
};

// ── Helpers ──
function isSportMoneyline(question) {
  return SPORTS_CONFIG.sportSeries.some(s => s.pattern.test(question));
}

function extractSport(question) {
  for (const s of SPORTS_CONFIG.sportSeries) {
    if (s.pattern.test(question)) return s.sport;
  }
  return "UNKNOWN";
}

function printRecord() {
  const s = state.getStats();
  const winRate = s.totalBets > 0 ? ((s.wins / s.totalBets) * 100).toFixed(1) : "0";
  console.log(
    `📊 Record: ${s.wins}W-${s.losses}L (${winRate}%) | P&L: $${s.pnl.toFixed(2)} | Active: ${s.activeBets}`
  );
}

// ── Preflight (same as before) ──
let _preflightDone = false;
async function ensureLiveReady() {
  if (botSettings.dryRun || _preflightDone) return;
  try {
    const { preflightCheck } = await import("./live-clob.js");
    const check = await preflightCheck(
      process.env.POLYMARKET_API_KEY,
      process.env.POLYMARKET_PRIVATE_KEY
    );
    check.messages.forEach(m => console.log(m));
    if (!check.ok) {
      console.error("❌ Live mode preflight FAILED — trading disabled");
      process.exit(1);
    }
    _preflightDone = true;
  } catch (err) {
    console.error("Preflight error:", err.message);
  }
}

/**
 * Main scan: find moneyline favorites, place $10-15 bets.
 */
export async function runScanCycle() {
  if (!botSettings.enabled) return { signals: null, exits: [], betsPlaced: 0 };

  if (!botSettings.dryRun) await ensureLiveReady();

  const balance = state.getDryBalance();
  const activeBets = state.getAllActiveBets();
  const maxConcurrent = 8; // max concurrent bets

  console.log(`
── SPORTS SCAN ${new Date().toISOString()} ──`);
  console.log(`💰 Balance: $${balance.toFixed(2)} | Active: ${activeBets.length}/${maxConcurrent}`);

  // ── Load all Polymarket markets ──
  let allMarkets = [];
  try {
    const poly = await import("./polymarket.js");
    allMarkets = await poly.getMarketsLive();
  } catch (err) {
    console.error("Market fetch error:", err.message);
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  if (!allMarkets || allMarkets.length === 0) {
    console.log("⚠️  No markets loaded");
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  // ── Filter: moneyline sports only ──
  const sportsMoneylines = allMarkets.filter(m => {
    const q = m.question || "";
    return isSportMoneyline(q) && !m.resolved;
  });

  console.log(`📊 Sports markets: ${sportsMoneylines.length} / ${allMarkets.length} total`);

  if (sportsMoneylines.length === 0) {
    console.log("[INFO] No sports moneylines available");
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  let betsPlaced = 0;
  const exits = [];

  // ── Process exits (TP/SL) ──
  for (const bet of activeBets) {
    if (bet.status !== "open") continue;

    const market = allMarkets.find(m => m.id === bet.marketId);
    if (!market) continue;

    const yesPrice = market.yesPrice || 0.5;
    const pnl = (bet.size / bet.entryPrice - bet.size / yesPrice).toFixed(2);
    const pnlPct = ((parseFloat(pnl) / bet.size) * 100).toFixed(1);

    // TP: if pnl ≥ 6%
    if (parseFloat(pnlPct) >= BET_CONFIG.tp.min * 100) {
      console.log(
        `    ✅ TP HIT | ${bet.sport} | +${pnlPct}% | $${pnl} | exit @ ${(yesPrice * 100).toFixed(1)}¢`
      );
      await state.closeBet(bet.id, "TP", yesPrice, parseFloat(pnl));
      exits.push({ id: bet.id, reason: "TP", pnl: parseFloat(pnl) });
      continue;
    }

    // SL: if pnl ≤ -15%
    if (parseFloat(pnlPct) <= -BET_CONFIG.sl * 100) {
      console.log(
        `    🔴 SL HIT | ${bet.sport} | ${pnlPct}% | $${pnl} | exit @ ${(yesPrice * 100).toFixed(1)}¢`
      );
      await state.closeBet(bet.id, "SL", yesPrice, parseFloat(pnl));
      exits.push({ id: bet.id, reason: "SL", pnl: parseFloat(pnl) });
    }
  }

  // ── Entry: scan for favorites ──
  const favoriteCandidates = sportsMoneylines
    .filter(m => {
      const yesPrice = m.yesPrice || 0.5;
      // Favorite if YES price ≤ threshold
      return yesPrice <= SPORTS_CONFIG.favoriteThreshold;
    })
    .sort((a, b) => (a.yesPrice || 0.5) - (b.yesPrice || 0.5)); // strongest favorites first

  for (const market of favoriteCandidates) {
    if (activeBets.length >= maxConcurrent) break;
    if (balance < BET_CONFIG.minBet) break;

    const yesPrice = market.yesPrice || 0.5;
    const sport = extractSport(market.question);

    // Check if already bet on this market
    if (state.hasActiveBet(market.id)) {
      continue;
    }

    // Place bet
    const betSize = Math.min(BET_CONFIG.betSize, balance * 0.1, BET_CONFIG.maxBet);
    if (betSize < BET_CONFIG.minBet) continue;

    try {
      const order = await import("./polymarket.js").then(p =>
        p.placeOrder({
          tokenId: market.id,
          side: "BUY",
          size: betSize,
          price: yesPrice,
          marketQuestion: market.question,
        })
      );

      if (order && order.status && order.status.includes("filled")) {
        const payout = (betSize / yesPrice).toFixed(2);
        const profit = (parseFloat(payout) - betSize).toFixed(2);

        console.log(
          `    ✅ ENTRY | ${sport} | $${betSize} @ ${(yesPrice * 100).toFixed(1)}¢` +
          ` | win → $${payout} (+$${profit})`
        );

        await state.recordBet({
          marketId: market.id,
          side: "YES",
          size: betSize,
          entryPrice: yesPrice,
          sport,
          question: market.question,
          status: "open",
          timestamp: new Date().toISOString(),
        });

        betsPlaced++;
        activeBets.push({
          id: market.id,
          marketId: market.id,
          sport,
          size: betSize,
          entryPrice: yesPrice,
          status: "open",
        });
      }
    } catch (err) {
      console.log(`    ⚠️  Entry failed | ${sport} | ${err.message}`);
    }
  }

  printRecord();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${activeBets.length}/${maxConcurrent} ──`);

  return { signals: null, exits, betsPlaced };
}

export async function runScannerLoop() {
  setInterval(async () => {
    try {
      await runScanCycle();
    } catch (err) {
      console.error("Scan error:", err.message);
    }
  }, 8000); // every 8s
}
