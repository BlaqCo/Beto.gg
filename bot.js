/**
 * bot.js — PolyBettor scan engine
 *
 * SHARP SHOOTER MODE:
 *   - Activated by env var SHARP_SHOOTER=true (boot) OR dashboard toggle (runtime)
 *   - 10 concurrent slots, $2 flat bets, up to 3 entries per scan
 *   - 3-5% TP, 8% SL (set in scalper.js)
 *   - Bypasses Kelly — bets on any directional bias
 *
 * NORMAL MODE:
 *   - 3 concurrent slots, 1 entry per scan, Kelly sizing
 */

import { computeSignals }                                    from "./signals.js";
import { fetchBTCMarkets, placeOrder, getBalance }           from "./polymarket.js";
import { recordBet, hasActiveBet, recordScan,
         getStats, getAllActiveBets }                         from "./state.js";
import { checkScalpExits, filterScalpMarkets, scalpQuality } from "./scalper.js";
import { sizeBet }                                           from "./kelly.js";
import { scoreSentiment }                                    from "./sentiment.js";

export const botSettings = {
  strategies:    { TREND_SCALP: true, MOMENTUM: true, MEAN_REVERT: true },
  autoMode:      true,
  enabled:       true,
  dryRun:        process.env.DRY_RUN !== "false",
  sharpShooter:  process.env.SHARP_SHOOTER === "true",  // ← env var activates at boot
};

const NORMAL_MAX          = 3;
const SS_MAX              = 20;
const SS_BET_SIZE         = 10.00;
const SS_ENTRIES_PER_SCAN = 5;

export async function runScanCycle() {
  if (!botSettings.enabled) return { signals: null, exits: [], betsPlaced: 0 };

  const DRY_RUN  = botSettings.dryRun;
  const SS_MODE  = botSettings.sharpShooter;
  const MAX_CONC = SS_MODE ? SS_MAX : NORMAL_MAX;

  let signals;
  try {
    signals = await computeSignals(botSettings.strategies, botSettings.autoMode);
  } catch (err) {
    console.error("Signal error:", err.message);
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  const modeTag = SS_MODE ? "⚡SHARP" : (botSettings.autoMode ? "AUTO" : "MANUAL");
  console.log(`\n── SCAN ${new Date().toISOString()} [${modeTag}] ──`);
  console.log(`₿ $${signals.currentPrice?.toFixed(1)} | Strategy: ${SS_MODE ? "SHARP_SHOOTER" : signals.activeStrategy} | Bias: ${signals.bias.toFixed(3)} ${signals.bias > 0.1 ? "↑BULL" : signals.bias < -0.1 ? "↓BEAR" : "→FLAT"} | Conf: ${(signals.confidence * 100).toFixed(0)}% | [${signals.leadMeta}]`);

  recordScan();

  let allMarkets = [];
  try { allMarkets = await fetchBTCMarkets(); }
  catch (err) { console.error("Market fetch error:", err.message); return { signals, exits: [], betsPlaced: 0 }; }

  // ── Exits first ──
  let exits = [];
  if (getAllActiveBets().length > 0) {
    const result = await checkScalpExits(allMarkets, signals, DRY_RUN, SS_MODE);
    exits = result.exits || [];
    for (const e of exits) {
      if (e.reason !== "expiry") {
        console.log(`  ${e.pnl > 0 ? "🟢" : "🔴"} EXIT [${e.reason.toUpperCase()}] ${e.side} | ${e.pnl >= 0 ? "+" : ""}$${e.pnl}`);
      }
    }
  }

  // ── Entry cap check ──
  const currentActive = getAllActiveBets().length;
  if (currentActive >= MAX_CONC) {
    console.log(`  ⏸ At max concurrent bets (${currentActive}/${MAX_CONC}) — skipping entries`);
    const s = getStats();
    console.log(`── +0 entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} | Scalps:${s.scalps} ──`);
    return { signals, exits, betsPlaced: 0 };
  }

  // ── New entries ──
  const scalpMarkets = filterScalpMarkets(allMarkets);
  let betsPlaced = 0;
  const balance  = await getBalance();
  const maxPerScan = SS_MODE ? SS_ENTRIES_PER_SCAN : 1;

  for (const market of scalpMarkets) {
    if (betsPlaced >= maxPerScan) break;
    if (getAllActiveBets().length >= MAX_CONC) break;

    const id = market.conditionId || market.condition_id;
    if (hasActiveBet(id)) continue;

    // SS: also skip if we already have ANY active bet on this question (prevents YES+NO on same market)
    if (SS_MODE) {
      const q = (market.question || "").toLowerCase().trim();
      const alreadyOnQuestion = getAllActiveBets().some(b =>
        (b.marketQuestion || "").toLowerCase().trim() === q
      );
      if (alreadyOnQuestion) continue;
    }

    // SS has a lower quality bar — any market with time left qualifies
    const qualityThreshold = SS_MODE ? 0.05 : 0.10;
    if (scalpQuality(market, signals) < qualityThreshold) continue;

    let finalBet, decision;

    if (SS_MODE) {
      // SharpShooter: only enter when there is actual momentum (not flat/dead market)
      // Require at least 0.05% BTC move in last candle OR bias confidence > 15%
      const btcMomentum = Math.abs(signals.bias) > 0.08 || signals.confidence > 0.15;
      if (!btcMomentum) continue;

      finalBet = SS_BET_SIZE;
      if (balance < finalBet) continue;

      const side = signals.bias >= 0 ? "YES" : "NO";
      decision = {
        shouldBet:   true,
        side,
        betSize:     finalBet,
        edge:        Math.abs(signals.bias) * 0.5,
        trueProb:    0.5 + Math.abs(signals.bias) * 0.3,
        impliedProb: 0.50,
        reasoning:   `⚡ SharpShooter $2 flat | bias:${signals.bias.toFixed(3)} → ${side}`,
      };
    } else {
      // Normal mode: full Kelly
      let sentiment = { sentimentBias: 0 };
      try { sentiment = await scoreSentiment(signals, market); } catch {}
      decision = sizeBet(signals, sentiment, market);
      if (!decision.shouldBet) continue;

      const maxBet = parseFloat(process.env.MAX_BET_SIZE || "5");
      finalBet = parseFloat(Math.min(decision.betSize, maxBet, balance * 0.15).toFixed(2));
      if (finalBet < 1 || balance < finalBet) continue;
    }

    const token = market.tokens?.find(t => t.outcome?.toLowerCase() === decision.side.toLowerCase());
    if (!token) continue;

    const entryPrice = token.price > 1 ? token.price / 100 : token.price;
    const minLeft    = market.endDateIso
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
        side:             decision.side,
        betSize:          finalBet,
        edge:             decision.edge,
        trueProbability:  decision.trueProb,
        impliedProbability: decision.impliedProb,
        orderId:          order.orderID || order.id,
        entryPrice,
        strategy:         SS_MODE ? "SHARP_SHOOTER" : signals.activeStrategy,
        reasoning:        decision.reasoning,
        entryBtcPrice:    signals.currentPrice,
        sharpShooter:     SS_MODE,
      });
      betsPlaced++;

      const tag = SS_MODE ? "⚡SHARP" : signals.activeStrategy;
      console.log(`  ✅ ENTRY ${decision.side} $${finalBet} @ ${(entryPrice*100).toFixed(1)}¢ | ${minLeft}min | ${tag} | edge:${(decision.edge*100).toFixed(1)}% | ${market.question?.slice(0,40)}`);
    } catch (err) {
      console.error(`  ❌ Order failed: ${err.message}`);
    }
  }

  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} | Scalps:${s.scalps} ──`);
  return { signals, exits, betsPlaced };
}
