/**
 * scalper.js — PolyBettor exit engine
 *
 * Key insight: synthetic markets regenerate each scan with new conditionIds.
 * We use CUMULATIVE BTC move from entryBtcPrice — not market object price.
 * Delta ~0.40 near ATM: 0.15% BTC move → ~6% contract gain → TP_LOW fires.
 */
import axios from "axios";
import { getAllActiveBets, closeBet } from "./state.js";

let cachedBtcPrice = null, lastBtcFetch = 0;

async function getLiveBtcPrice() {
  if (cachedBtcPrice && Date.now() - lastBtcFetch < 5000) return cachedBtcPrice;
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Ticker",
      { params: { pair: "XBTUSD" }, timeout: 4000 });
    const p = parseFloat(data.result?.XXBTZUSD?.c?.[0]);
    if (p > 0) { cachedBtcPrice = p; lastBtcFetch = Date.now(); }
  } catch {}
  return cachedBtcPrice;
}

function estimateContractPrice(bet, currentBtc) {
  if (!currentBtc || !bet.entryBtcPrice || !bet.entryPrice) return bet.entryPrice;
  const btcChangePct = (currentBtc - bet.entryBtcPrice) / bet.entryBtcPrice;
  const q = (bet.marketQuestion || "").toLowerCase();
  const isUpOrDown = q.includes("up or down") || q.includes("up/down");
  let isLong;
  if (isUpOrDown) {
    isLong = bet.side === "YES";
  } else {
    const isBullQ = q.includes("above") || q.includes("higher") || q.includes("rise") || q.includes("reach");
    isLong = isBullQ ? bet.side === "YES" : bet.side === "NO";
  }
  const distFromMid = Math.abs(bet.entryPrice - 0.5);
  const delta = Math.max(0.20, 0.45 - distFromMid * 0.4);
  const priceMove = btcChangePct * delta * (isLong ? 1 : -1);
  return Math.max(0.02, Math.min(0.98, bet.entryPrice + priceMove));
}

export async function checkScalpExits(markets, signals, dryRun = true) {
  const active = getAllActiveBets();
  if (active.length === 0) return { exits: [], currentBtc: null };

  const currentBtc = await getLiveBtcPrice();

  const TP_LOW    = parseFloat(process.env.TP_LOW     || "0.06");
  const TP_HIGH   = parseFloat(process.env.TP_HIGH    || "0.14");
  const STOP_LOSS = parseFloat(process.env.STOP_LOSS  || "0.15");
  const TRAIL_AT  = parseFloat(process.env.TRAIL_AFTER|| "0.05");
  const TRAIL_PCT = parseFloat(process.env.TRAIL_PCT  || "0.035");

  const exits = [];
  const trailState = checkScalpExits._trail || (checkScalpExits._trail = new Map());

  for (const bet of active) {
    if (!bet.entryPrice) continue;

    const currentPrice = estimateContractPrice(bet, currentBtc);
    const pnlPct = (currentPrice - bet.entryPrice) / bet.entryPrice;

    // Trailing stop
    let trail = trailState.get(bet.marketConditionId);
    if (!trail) { trail = { peak: currentPrice }; trailState.set(bet.marketConditionId, trail); }
    if (currentPrice > trail.peak) trail.peak = currentPrice;
    const peakGain = (trail.peak - bet.entryPrice) / bet.entryPrice;
    if (peakGain >= TRAIL_AT) trail.trailStop = trail.peak * (1 - TRAIL_PCT);

    let shouldExit = false, exitReason = "", exitPrice = currentPrice;

    // Exit triggers
    if      (pnlPct >= TP_HIGH)                                      { shouldExit = true; exitReason = "TAKE_PROFIT_MAX"; }
    else if (pnlPct >= TP_LOW)                                        { shouldExit = true; exitReason = "TAKE_PROFIT"; }
    else if (trail.trailStop && currentPrice <= trail.trailStop)      { shouldExit = true; exitReason = "TRAIL_STOP"; }
    else if (pnlPct <= -STOP_LOSS)                                    { shouldExit = true; exitReason = "STOP_LOSS"; }

    // Expiry check
    const endDate = bet.marketEndDateIso;
    if (endDate) {
      const msLeft = new Date(endDate) - Date.now();
      if (msLeft > 0 && msLeft < 90 * 1000 && pnlPct <= 0 && !shouldExit) {
        // Near expiry: only exit losers — let winners ride to settlement
        shouldExit = true; exitReason = "NEAR_EXPIRY";
      } else if (msLeft <= 0 && !shouldExit) {
        shouldExit = true; exitReason = "EXPIRED";
        // Settle based on actual BTC direction vs entry
        const q = (bet.marketQuestion || "").toLowerCase();
        const isUpOrDown = q.includes("up or down") || q.includes("up/down");
        const isLong = isUpOrDown
          ? bet.side === "YES"
          : (q.includes("above")||q.includes("higher")) ? bet.side === "YES" : bet.side === "NO";
        const btcWentUp = currentBtc && bet.entryBtcPrice && currentBtc > bet.entryBtcPrice;
        exitPrice = (isLong ? btcWentUp : !btcWentUp) ? 0.92 : 0.08;
      }
    }

    if (!shouldExit) {
      const btcMov = currentBtc && bet.entryBtcPrice
        ? ((currentBtc - bet.entryBtcPrice) / bet.entryBtcPrice * 100).toFixed(3) + "%"
        : "?%";
      console.log(`  📊 HOLD ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(0)}¢ now:${(currentPrice*100).toFixed(0)}¢ | ${pnlPct >= 0 ? "+" : ""}${(pnlPct*100).toFixed(1)}% | BTC cumulative:${btcMov}`);
      continue;
    }

    const finalPnlPct = (exitPrice - bet.entryPrice) / bet.entryPrice;
    const finalPnl    = parseFloat((bet.betSize * finalPnlPct).toFixed(2));
    const isExpiry    = exitReason === "EXPIRED" || exitReason === "NEAR_EXPIRY";

    if (!isExpiry) {
      console.log(`  🎯 EXIT [${exitReason}] ${bet.side} $${bet.betSize} | ${(bet.entryPrice*100).toFixed(0)}¢→${(exitPrice*100).toFixed(0)}¢ | ${finalPnl >= 0 ? "+" : ""}$${finalPnl} (${finalPnl >= 0 ? "+" : ""}${(finalPnlPct*100).toFixed(1)}%)`);
    } else {
      console.log(`  ⏱ EXPIRED ${bet.side} $${bet.betSize} | refunded (excluded from P&L)`);
    }

    closeBet(bet.marketConditionId, {
      exitPrice,
      reason: isExpiry ? "expiry"
            : exitReason.startsWith("TAKE_PROFIT") ? "take_profit"
            : exitReason === "TRAIL_STOP" ? "trail_stop"
            : "stop_loss",
      pnl: finalPnl,
    });
    trailState.delete(bet.marketConditionId);
    exits.push({ market: bet.marketQuestion, side: bet.side, pnlPct: finalPnlPct, pnl: finalPnl, reason: isExpiry ? "expiry" : exitReason.toLowerCase() });
  }

  return { exits, currentBtc };
}

export function filterScalpMarkets(markets) {
  return markets.filter(m => {
    if (!m.endDateIso && !m.endDate) return true;
    const minLeft = (new Date(m.endDateIso || m.endDate) - Date.now()) / 60000;
    return minLeft >= 3 && minLeft <= 180;
  });
}

export function scalpQuality(market, signals) {
  let score = 0;
  if (market.endDateIso || market.endDate) {
    const minLeft = (new Date(market.endDateIso || market.endDate) - Date.now()) / 60000;
    if (minLeft < 3 || minLeft > 180) return 0;
    if (minLeft >= 4 && minLeft <= 20)       score += 0.40;
    else if (minLeft <= 90)                  score += 0.25;
    else                                     score += 0.10;
  } else score += 0.20;
  score += Math.min(0.40, signals.confidence * 0.45);
  score += Math.min(0.20, Math.abs(signals.bias) * 0.25);
  return Math.min(1, score);
}
