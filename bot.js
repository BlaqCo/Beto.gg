/**
 * bot.js — PolyBettor scan engine v3
 *
 * ★ VALUE MODE (env VALUE_MODE=true) — the favorite-longshot strategy ★
 * ─────────────────────────────────────────────────────────────────────
 * The single most documented edge in prediction market research:
 * high-probability "favorite" contracts are systematically UNDERPRICED
 * and longshots are systematically OVERPRICED. (Thaler & Ziemba 1988;
 * Snowberg & Wolfers 2010; confirmed on Polymarket/Kalshi 2024-2026.)
 *
 * Our own dry-run data confirms it:
 *   entries ≥50¢ → 75% wins, +$15.88
 *   entries <45¢ → 11% wins, −$19.48
 *
 * Rules:
 *   1. Price every market with Black-Scholes binary model
 *   2. ONLY buy sides whose model fair value is 65–93¢ (favorites)
 *   3. ONLY enter when fair value beats market price by ≥6¢
 *      (covers 2% fee + 0.5¢ slippage + model error)
 *   4. 10–75 min to expiry (the 15m–1h sweet spot)
 *   5. Quarter-Kelly sizing, $2–$8 per bet
 *   6. Max 2 positions per coin (diversify), 8 concurrent, 2/scan
 *   7. Hold to expiry — favorites converge to $1. Disaster stop at
 *      fair ≤40¢, profit-lock at fair ≥97¢. $50 daily loss limit.
 *
 * Mode priority: VALUE_MODE > SHARP_SHOOTER > normal
 */

import { computeSignals }                                     from "./signals.js";
import { fetchBTCMarkets, placeOrder, getBalance }            from "./polymarket.js";
import { recordBet, hasActiveBet, recordScan, getStats,
         getAllActiveBets }                                    from "./state.js";
import { checkScalpExits, filterScalpMarkets, scalpQuality,
         priceMarket }                                         from "./scalper.js";
import { sizeBet }                                            from "./kelly.js";
import { scoreSentiment }                                     from "./sentiment.js";

export const botSettings = {
  strategies:   { TREND_SCALP: true, MOMENTUM: true, MEAN_REVERT: true },
  autoMode:     true,
  enabled:      true,
  dryRun:       process.env.DRY_RUN !== "false",
  sharpShooter: process.env.SHARP_SHOOTER === "true",
  valueMode:    process.env.VALUE_MODE === "true",
};

// ── Normal / SharpShooter constants ──
const NORMAL_MAX          = 3;
const SS_MAX              = 10;
const SS_MIN_CONFIDENCE   = 0.25;
const SS_BET_SIZE         = 5.00;
const SS_ENTRIES_PER_SCAN = 3;

// ── VALUE strategy constants ──
const V_MAX             = 8;     // concurrent positions
const V_ENTRIES         = 2;     // entries per scan
const V_MIN_EDGE        = 0.06;  // fair − price ≥ 6¢
const V_FAV_MIN         = 0.65;  // favorite zone floor
const V_FAV_MAX         = 0.93;  // ceiling — above this payoff < fee+slip
const V_MIN_MINUTES     = 10;
const V_MAX_MINUTES     = 75;
const V_MAX_PER_COIN    = 2;
const V_KELLY_FRACTION  = 0.25;  // quarter Kelly
const V_MIN_BET         = 2.00;
const V_MAX_BET         = 8.00;
const MAX_DAILY_LOSS    = 50;    // all modes

const SLIPPAGE = 0.005;

function summary(exits, betsPlaced, maxConc) {
  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${maxConc} | P&L:$${s.pnl} | Scalps:${s.scalps} ──`);
}

export async function runScanCycle() {
  if (!botSettings.enabled) return { signals: null, exits: [], betsPlaced: 0 };

  const DRY_RUN    = botSettings.dryRun;
  const VALUE_MODE = botSettings.valueMode;
  const SS_MODE    = !VALUE_MODE && botSettings.sharpShooter;
  const MAX_CONC   = VALUE_MODE ? V_MAX : SS_MODE ? SS_MAX : NORMAL_MAX;

  // ── Signals ──
  let signals;
  try {
    signals = await computeSignals(botSettings.strategies, botSettings.autoMode);
  } catch (err) {
    console.error("Signal error:", err.message);
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  const modeTag = VALUE_MODE ? "🎯VALUE" : SS_MODE ? "⚡SHARP" : (botSettings.autoMode ? "AUTO" : "MANUAL");
  console.log(`\n── SCAN ${new Date().toISOString()} [${modeTag}] ──`);
  console.log(`₿ $${signals.currentPrice?.toFixed(1)} | Strategy: ${VALUE_MODE ? "VALUE" : SS_MODE ? "SHARP_SHOOTER" : signals.activeStrategy} | Bias: ${signals.bias.toFixed(3)} ${signals.bias > 0.1 ? "↑BULL" : signals.bias < -0.1 ? "↓BEAR" : "→FLAT"} | Conf: ${(signals.confidence * 100).toFixed(0)}%`);

  recordScan();

  // ── Fetch markets ──
  let allMarkets = [];
  try { allMarkets = await fetchBTCMarkets(); }
  catch (err) {
    console.error("Market fetch error:", err.message);
    return { signals, exits: [], betsPlaced: 0 };
  }

  // ── Exits first ──
  let exits = [];
  if (getAllActiveBets().length > 0) {
    const result = await checkScalpExits(allMarkets, signals, DRY_RUN, SS_MODE);
    exits = result.exits || [];
  }

  // ── Caps ──
  if (getAllActiveBets().length >= MAX_CONC) {
    console.log(`  ⏸ At max concurrent bets (${getAllActiveBets().length}/${MAX_CONC})`);
    summary(exits, 0, MAX_CONC);
    return { signals, exits, betsPlaced: 0 };
  }

  const currentPnl = parseFloat(getStats().pnl);
  if (currentPnl < -MAX_DAILY_LOSS) {
    console.log(`  🛑 Daily loss limit hit ($${currentPnl.toFixed(2)}) — pausing entries`);
    summary(exits, 0, MAX_CONC);
    return { signals, exits, betsPlaced: 0 };
  }

  // Shuffle so all 6 coins get a fair shot
  const scalpMarkets = filterScalpMarkets(allMarkets).sort(() => Math.random() - 0.5);
  let betsPlaced     = 0;
  const balance      = await getBalance();
  const maxPerScan   = VALUE_MODE ? V_ENTRIES : SS_MODE ? SS_ENTRIES_PER_SCAN : 1;

  for (const market of scalpMarkets) {
    if (betsPlaced >= maxPerScan) break;
    if (getAllActiveBets().length >= MAX_CONC) break;

    const id = market.conditionId || market.condition_id;
    if (hasActiveBet(id)) continue;

    // One position per question, any mode
    const q = (market.question || "").toLowerCase().trim();
    if (getAllActiveBets().some(b => (b.marketQuestion || "").toLowerCase().trim() === q)) continue;

    let finalBet, decision, pricing = null;

    if (VALUE_MODE) {
      // ════════ VALUE STRATEGY ════════
      const minLeft = market.endDateIso
        ? (new Date(market.endDateIso) - Date.now()) / 60000 : null;
      if (!minLeft || minLeft < V_MIN_MINUTES || minLeft > V_MAX_MINUTES) continue;

      // Diversification: max 2 per coin
      const coin = (market.coin || "BTC").toUpperCase();
      const onCoin = getAllActiveBets().filter(b => (b.entryCoin || "BTC").toUpperCase() === coin).length;
      if (onCoin >= V_MAX_PER_COIN) continue;

      pricing = await priceMarket(market);
      if (!pricing) continue;
      const { probYes, strike, direction } = pricing;

      // Evaluate both sides — pick the one with the most edge
      let best = null;
      for (const token of market.tokens || []) {
        const sideName = (token.outcome || "").toUpperCase();
        if (sideName !== "YES" && sideName !== "NO") continue;
        let price = token.price > 1 ? token.price / 100 : token.price;
        if (!price || price <= 0 || price >= 1) continue;
        const sideFV = sideName === "YES" ? probYes : 1 - probYes;
        const edge   = sideFV - (price + SLIPPAGE);
        if (!best || edge > best.edge) best = { sideName, price, sideFV, edge, token };
      }
      if (!best) continue;

      // FILTERS: real edge + favorite zone only. Never buy longshots.
      if (best.edge < V_MIN_EDGE) continue;
      if (best.sideFV < V_FAV_MIN || best.sideFV > V_FAV_MAX) continue;

      // BTC signal veto: don't buy a favorite that momentum is attacking
      if (coin === "BTC" && Math.abs(signals.bias) > 0.30) {
        const isLong = (direction === "above") === (best.sideName === "YES");
        if (( isLong && signals.bias < -0.30) ||
            (!isLong && signals.bias >  0.30)) continue;
      }

      // Quarter-Kelly sizing
      const fill = best.price + SLIPPAGE;
      const b    = (1 / fill) - 1;             // net odds
      const p    = best.sideFV;
      const fStar = (b * p - (1 - p)) / b;     // full Kelly fraction
      if (fStar <= 0) continue;
      const maxEnv = parseFloat(process.env.MAX_BET_SIZE || "10");
      finalBet = parseFloat(Math.min(
        Math.max(balance * fStar * V_KELLY_FRACTION, V_MIN_BET),
        V_MAX_BET, maxEnv, balance * 0.15
      ).toFixed(2));
      if (balance < finalBet || finalBet < V_MIN_BET) continue;

      decision = {
        shouldBet:   true,
        side:        best.sideName,
        betSize:     finalBet,
        edge:        best.edge,
        trueProb:    best.sideFV,
        impliedProb: best.price,
        reasoning:   `🎯VALUE | fair:${(best.sideFV*100).toFixed(0)}¢ vs price:${(best.price*100).toFixed(0)}¢ | edge:+${(best.edge*100).toFixed(1)}¢ | Kelly:$${finalBet}`,
      };

    } else if (SS_MODE) {
      // ════════ SHARP SHOOTER (fade the extreme) ════════
      if (scalpQuality(market, signals) < 0.05) continue;
      if (signals.confidence < SS_MIN_CONFIDENCE) continue;
      if (Math.abs(signals.bias) < 0.10) continue;

      finalBet = SS_BET_SIZE;
      if (balance < finalBet) continue;

      const ql      = q;
      const isBullQ = ql.includes("rise above") || ql.includes("reach") ||
                      ql.includes("hit")        || ql.includes("above");
      const isBearQ = ql.includes("drop below") || ql.includes("fall below") ||
                      (ql.includes("below") && !ql.includes("above"));
      const isBear  = signals.bias < 0;

      let side;
      if (isBullQ)      side = isBear ? "NO"  : "YES";
      else if (isBearQ) side = isBear ? "YES" : "NO";
      else              side = isBear ? "NO"  : "YES";

      decision = {
        shouldBet: true, side, betSize: finalBet,
        edge:        signals.confidence * Math.abs(signals.bias),
        trueProb:    0.5 + signals.confidence * 0.4,
        impliedProb: 0.50,
        reasoning:   `⚡SS | bias:${signals.bias.toFixed(3)} conf:${(signals.confidence*100).toFixed(0)}%`,
      };

    } else {
      // ════════ NORMAL (Kelly + sentiment) ════════
      if (scalpQuality(market, signals) < 0.10) continue;
      let sentiment = { sentimentBias: 0 };
      try { sentiment = await scoreSentiment(signals, market); } catch {}
      decision = sizeBet(signals, sentiment, market);
      if (!decision.shouldBet) continue;

      const maxBet = parseFloat(process.env.MAX_BET_SIZE || "5");
      finalBet = parseFloat(Math.min(decision.betSize, maxBet, balance * 0.15).toFixed(2));
      if (finalBet < 1 || balance < finalBet) continue;
    }

    const token = VALUE_MODE
      ? (market.tokens || []).find(t => (t.outcome || "").toUpperCase() === decision.side)
      : market.tokens?.find(t => t.outcome?.toLowerCase() === decision.side.toLowerCase());
    if (!token) continue;

    const entryPrice = token.price > 1 ? token.price / 100 : token.price;
    const minsLeft   = market.endDateIso
      ? ((new Date(market.endDateIso) - Date.now()) / 60000).toFixed(0)
      : "?";

    try {
      const order = await placeOrder({
        tokenId: token.tokenId || token.token_id,
        side: "BUY", size: finalBet, price: entryPrice,
        marketQuestion: market.question,
      });

      recordBet({
        market,
        side:               decision.side,
        betSize:            finalBet,
        edge:               decision.edge,
        trueProbability:    decision.trueProb,
        impliedProbability: decision.impliedProb,
        orderId:            order.orderID || order.id,
        entryPrice,
        strategy:           VALUE_MODE ? "VALUE" : SS_MODE ? "SHARP_SHOOTER" : signals.activeStrategy,
        reasoning:          decision.reasoning,
        entryBtcPrice:      pricing?.spot ?? signals.currentPrice,
        entryCoin:          market.coin || "BTC",
        sharpShooter:       SS_MODE,
        valueBet:           VALUE_MODE,
        strike:             pricing?.strike    ?? null,
        direction:          pricing?.direction ?? null,
      });
      betsPlaced++;

      const tag = VALUE_MODE ? "🎯VALUE" : SS_MODE ? "⚡SHARP" : signals.activeStrategy;
      console.log(`  ✅ ENTRY ${decision.side} $${finalBet} @ ${(entryPrice*100).toFixed(1)}¢ | ${minsLeft}min | ${tag} | ${decision.reasoning || ""} | ${market.question?.slice(0,45)}`);
    } catch (err) {
      console.error(`  ❌ Order failed: ${err.message}`);
    }
  }

  summary(exits, betsPlaced, MAX_CONC);
  return { signals, exits, betsPlaced };
}
