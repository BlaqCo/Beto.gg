/**
 * scalper.js — PolyBettor exit engine
 *
 * SHARPSHOOTER mode: tighter TP (3-5% of bet), same stop loss
 * NORMAL mode: existing TP_LOW/TP_HIGH thresholds
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

// ssMode passed in from bot.js so exit thresholds adapt
export async function checkScalpExits(markets, signals, dryRun = true, ssMode = false) {
  const active = getAllActiveBets();
  if (active.length === 0) return { exits: [], currentBtc: null };

  const currentBtc = await getLiveBtcPrice();

  // SharpShooter: 3% TP, 5% max TP, tight stop 8%
  // Normal: env-configurable
  // SharpShooter: ultra-tight TP so exits fire on small BTC moves in sideways markets
  // 0.5% TP = ~$0.01 profit per $2 bet, but 10 slots cycling fast adds up
  const TP_LOW   = ssMode ? 0.005 : parseFloat(process.env.TP_LOW    || "0.06");
  const TP_HIGH  = ssMode ? 0.015 : parseFloat(process.env.TP_HIGH   || "0.14");
  const STOP_LOSS= ssMode ? 0.04  : parseFloat(process.env.STOP_LOSS || "0.15");
  const TRAIL_AT = ssMode ? 0.005 : parseFloat(process.env.TRAIL_AFTER|| "0.05");
  const TRAIL_PCT= ssMode ? 0.003 : parseFloat(process.env.TRAIL_PCT  || "0.035");

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

    // SharpShooter: force-close after 2 min regardless of price — guarantees slot cycling
    const heldMs = bet.placedAt ? Date.now() - new Date(bet.placedAt).getTime() : 0;
    const timeExpired = ssMode && heldMs >= 2 * 60 * 1000;

    if      (pnlPct >= TP_HIGH)                                { shouldExit = true; exitReason = "take_profit_max"; }
    else if (pnlPct >= TP_LOW)                                 { shouldExit = true; exitReason = "take_profit"; }
    else if (trail.trailStop && currentPrice <= trail.trailStop){ shouldExit = true; exitReason = "trail_stop"; }
    else if (pnlPct <= -STOP_LOSS)                             { shouldExit = true; exitReason = "stop_loss"; }
    else if (timeExpired)                                       { shouldExit = true; exitReason = "timeout"; }

    // Expiry check
    const endDate = bet.marketEndDateIso;
    if (endDate) {
      const msLeft = new Date(endDate) - Date.now();
      if (msLeft > 0 && msLeft < 90 * 1000 && pnlPct <= 0 && !shouldExit) {
        shouldExit = true; exitReason = "near_expiry";
      } else if (msLeft <= 0 && !shouldExit) {
        shouldExit = true; exitReason = "expiry";
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
      const ssTag = bet.sharpShooter ? " ⚡" : "";
      console.log(`  📊 HOLD${ssTag} ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(0)}¢ now:${(currentPrice*100).toFixed(0)}¢ | ${pnlPct >= 0 ? "+" : ""}${(pnlPct*100).toFixed(1)}% | BTC cumulative:${btcMov}`);
      continue;
    }

    const isExpiry = exitReason === "expiry" || exitReason === "near_expiry";
    const finalPnlPct = (exitPrice - bet.entryPrice) / bet.entryPrice;
    const finalPnl    = parseFloat((bet.betSize * finalPnlPct).toFixed(2));

    if (!isExpiry) {
      const ssTag = bet.sharpShooter ? "⚡SS " : "";
      console.log(`  🎯 ${ssTag}EXIT [${exitReason.toUpperCase()}] ${bet.side} $${bet.betSize} | ${(bet.entryPrice*100).toFixed(0)}¢→${(exitPrice*100).toFixed(0)}¢ | ${finalPnl >= 0 ? "+" : ""}$${finalPnl} (${(finalPnlPct*100).toFixed(1)}%)`);
    } else {
      console.log(`  ⏱ EXPIRED ${bet.side} $${bet.betSize} | refunded (excluded from P&L)`);
    }

    closeBet(bet.marketConditionId, {
      exitPrice,
      reason: isExpiry ? "expiry"
        : exitReason === "take_profit_max" ? "take_profit_max"
        : exitReason === "take_profit"     ? "take_profit"
        : exitReason === "trail_stop"      ? "trail_stop"
        : "stop_loss",
      pnl: finalPnl,
    });

    trailState.delete(bet.marketConditionId);
    exits.push({
      market: bet.marketQuestion, side: bet.side,
      pnlPct: finalPnlPct, pnl: finalPnl,
      reason: isExpiry ? "expiry" : exitReason,
      sharpShooter: bet.sharpShooter || false,
    });
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
    if (minLeft >= 4 && minLeft <= 20) score += 0.40;
    else if (minLeft <= 90)            score += 0.25;
    else                               score += 0.10;
  } else score += 0.20;

  score += Math.min(0.40, signals.confidence * 0.45);
  score += Math.min(0.20, Math.abs(signals.bias) * 0.25);
  return Math.min(1, score);
}
