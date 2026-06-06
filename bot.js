/**
 * bot.js — PolyBettor scan engine
 * Hard cap: MAX_CONCURRENT bets. 1 new bet per scan.
 */
import { computeSignals }                                    from "./signals.js";
import { fetchBTCMarkets, placeOrder, getBalance }           from "./polymarket.js";
import { recordBet, hasActiveBet, recordScan,
         getStats, getAllActiveBets }                         from "./state.js";
import { checkScalpExits, filterScalpMarkets, scalpQuality } from "./scalper.js";
import { sizeBet }                                           from "./kelly.js";
import { scoreSentiment }                                    from "./sentiment.js";

export const botSettings = {
  strategies: { TREND_SCALP: true, MOMENTUM: true, MEAN_REVERT: true },
  autoMode: true,
  enabled: true,
  dryRun: process.env.DRY_RUN !== "false",
};

const MAX_CONCURRENT = 3;

export async function runScanCycle() {
  if (!botSettings.enabled) return { signals: null, exits: [], betsPlaced: 0 };
  const DRY_RUN = botSettings.dryRun;

  let signals;
  try {
    signals = await computeSignals(botSettings.strategies, botSettings.autoMode);
  } catch (err) {
    console.error("Signal error:", err.message);
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  console.log(`\n── SCAN ${new Date().toISOString()} [${botSettings.autoMode ? "AUTO" : "MANUAL"}] ──`);
  console.log(`₿ $${signals.currentPrice?.toFixed(1)} | Strategy: ${signals.activeStrategy} | Bias: ${signals.bias.toFixed(3)} ${signals.bias > 0.1 ? "↑BULL" : signals.bias < -0.1 ? "↓BEAR" : "→FLAT"} | Conf: ${(signals.confidence * 100).toFixed(0)}% | [${signals.leadMeta}]`);

  recordScan();

  let allMarkets = [];
  try { allMarkets = await fetchBTCMarkets(); }
  catch (err) { console.error("Market fetch error:", err.message); return { signals, exits: [], betsPlaced: 0 }; }

  // ── Exits first ──
  let exits = [];
  if (getAllActiveBets().length > 0) {
    const result = await checkScalpExits(allMarkets, signals, DRY_RUN);
    exits = result.exits || [];
    for (const e of exits) {
      if (e.reason !== "expiry") {
        console.log(`  ${e.pnl > 0 ? "🟢" : "🔴"} EXIT [${e.reason.toUpperCase()}] ${e.side} | ${e.pnl >= 0 ? "+" : ""}$${e.pnl}`);
      }
    }
  }

  // ── Entry cap check ──
  const currentActive = getAllActiveBets().length;
  if (currentActive >= MAX_CONCURRENT) {
    console.log(`  ⏸ At max concurrent bets (${currentActive}/${MAX_CONCURRENT}) — skipping entries`);
    const s = getStats();
    console.log(`── +0 entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONCURRENT} | P&L:$${s.pnl} | Scalps:${s.scalps} ──`);
    return { signals, exits, betsPlaced: 0 };
  }

  // ── New entries ──
  const scalpMarkets = filterScalpMarkets(allMarkets);
  let betsPlaced = 0;
  const balance = await getBalance();

  for (const market of scalpMarkets) {
    if (betsPlaced >= 1) break;
    if (getAllActiveBets().length >= MAX_CONCURRENT) break;

    const id = market.conditionId || market.condition_id;
    if (hasActiveBet(id)) continue;
    if (scalpQuality(market, signals) < 0.10) continue;

    let sentiment = { sentimentBias: 0 };
    try { sentiment = await scoreSentiment(signals, market); } catch {}

    const decision = sizeBet(signals, sentiment, market);
    if (!decision.shouldBet) continue;

    const maxBet  = parseFloat(process.env.MAX_BET_SIZE || "5");
    const finalBet = parseFloat(Math.min(decision.betSize, maxBet, balance * 0.15).toFixed(2));
    if (finalBet < 1 || balance < finalBet) continue;

    const token = market.tokens?.find(t => t.outcome?.toLowerCase() === decision.side.toLowerCase());
    if (!token) continue;

    const entryPrice = token.price > 1 ? token.price / 100 : token.price;
    const minLeft    = market.endDateIso ? ((new Date(market.endDateIso) - Date.now()) / 60000).toFixed(0) : "?";

    try {
      const order = await placeOrder({
        tokenId: token.tokenId || token.token_id,
        side: "BUY", size: finalBet, price: entryPrice,
        marketQuestion: market.question,
      });

      recordBet({
        market, side: decision.side, betSize: finalBet,
        edge: decision.edge, trueProbability: decision.trueProb,
        impliedProbability: decision.impliedProb,
        orderId: order.orderID || order.id,
        entryPrice, strategy: signals.activeStrategy,
        reasoning: decision.reasoning,
        entryBtcPrice: signals.currentPrice, // locked for cumulative delta math
      });
      betsPlaced++;
      console.log(`  ✅ ENTRY ${decision.side} $${finalBet} @ ${(entryPrice*100).toFixed(1)}¢ | ${minLeft}min | ${signals.activeStrategy} | edge:${(decision.edge*100).toFixed(1)}% | ${market.question?.slice(0,40)}`);
    } catch (err) {
      console.error(`  ❌ Order failed: ${err.message}`);
    }
  }

  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONCURRENT} | P&L:$${s.pnl} | Scalps:${s.scalps} ──`);
  return { signals, exits, betsPlaced };
}
