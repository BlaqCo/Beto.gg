/**
 * scalper.js — PolyBettor exit engine (SharpShooter optimized)
 *
 * SS MODE goals:
 *   - $0.10–$0.15 profit per $10 bet (1–1.5% BTC move)
 *   - Slots never sit idle — timeout at 2 min so empty slots refill immediately
 *   - Stop loss at 0.8% BTC against to cut losers fast
 *   - Trailing stop locks in gains once 0.8% profit reached
 *   - At expiry, attempt to settle at market price for real P&L
 */
import axios from "axios";
import { getAllActiveBets, closeBet } from "./state.js";

let _priceCache = {}, _priceFetchTime = 0;

async function getLivePrices() {
  if (Date.now() - _priceFetchTime < 8000 && Object.keys(_priceCache).length > 0) return _priceCache;
  const p = { BTC: null, ETH: null, SOL: null, BNB: null, XRP: null, DOGE: null };
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Ticker",
      { params: { pair: "XBTUSD,ETHUSD" }, timeout: 4000 });
    const r = data.result || {};
    if (r.XXBTZUSD?.c?.[0]) p.BTC = parseFloat(r.XXBTZUSD.c[0]);
    if (r.XETHZUSD?.c?.[0]) p.ETH = parseFloat(r.XETHZUSD.c[0]);
  } catch {}
  try {
    const { data } = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      { params: { ids: "solana,binancecoin,ripple,dogecoin", vs_currencies: "usd" }, timeout: 4000 }
    );
    if (data.solana?.usd)      p.SOL  = data.solana.usd;
    if (data.binancecoin?.usd) p.BNB  = data.binancecoin.usd;
    if (data.ripple?.usd)      p.XRP  = data.ripple.usd;
    if (data.dogecoin?.usd)    p.DOGE = data.dogecoin.usd;
  } catch {}
  // merge with cache — keep last known for any coin that failed
  _priceCache = { ..._priceCache, ...Object.fromEntries(Object.entries(p).filter(([,v]) => v)) };
  _priceFetchTime = Date.now();
  return _priceCache;
}

async function getLiveBtcPrice() {
  const prices = await getLivePrices();
  return prices.BTC || null;
}

function getCoinPrice(prices, coin) {
  return prices[(coin || "BTC").toUpperCase()] || prices.BTC || null;
}

function getBetDirection(bet) {
  const q = (bet.marketQuestion || "").toLowerCase();
  const isUpOrDown = q.includes("up or down") || q.includes("up/down");
  const isBullQ = q.includes("above") || q.includes("higher") ||
                  q.includes("rise") || q.includes("reach");
  return isUpOrDown ? bet.side === "YES" : (isBullQ ? bet.side === "YES" : bet.side === "NO");
}

function estimateContractPrice(bet, currentBtc) {
  if (!currentBtc || !bet.entryBtcPrice || !bet.entryPrice) return bet.entryPrice;
  const btcChangePct = (currentBtc - bet.entryBtcPrice) / bet.entryBtcPrice;
  const isLong = getBetDirection(bet);
  const distFromMid = Math.abs(bet.entryPrice - 0.5);
  const delta = Math.max(0.20, 0.45 - distFromMid * 0.4);
  return Math.max(0.02, Math.min(0.98, bet.entryPrice + btcChangePct * delta * (isLong ? 1 : -1)));
}

export async function checkScalpExits(markets, signals, dryRun = true, ssMode = false) {
  const active = getAllActiveBets();
  if (active.length === 0) return { exits: [], currentBtc: null };

  const prices    = await getLivePrices();
  const currentBtc = prices.BTC || null;

  // ── Thresholds ──────────────────────────────────────────────────────────
  // SS: targets $0.10–$0.15 profit on $10 bet = 1–1.5% BTC move
  // Timeout at 2 min — slots MUST cycle fast, never sit idle
  const TP_LOW    = ssMode ? 0.010 : parseFloat(process.env.TP_LOW     || "0.06");
  const TP_HIGH   = ssMode ? 0.015 : parseFloat(process.env.TP_HIGH    || "0.14");
  const STOP_LOSS = ssMode ? 0.008 : parseFloat(process.env.STOP_LOSS  || "0.15");
  const TRAIL_AT  = ssMode ? 0.010 : parseFloat(process.env.TRAIL_AFTER || "0.05");
  const TRAIL_PCT = ssMode ? 0.003 : parseFloat(process.env.TRAIL_PCT   || "0.035");
  const TIMEOUT_MS = ssMode ? 2 * 60 * 1000 : Infinity; // 2 min SS, no timeout normal

  const exits = [];
  const trailState = checkScalpExits._trail || (checkScalpExits._trail = new Map());

  for (const bet of active) {
    if (!bet.entryPrice) continue;

    // ── P&L calculation ────────────────────────────────────────────────
    let currentPrice, pnlPct;
    // Use the correct coin price for this bet
    const coinPrice = getCoinPrice(prices, bet.entryCoin || "BTC");
    const entryRefPrice = bet.entryBtcPrice; // stored at entry time

    if (ssMode && coinPrice && entryRefPrice) {
      // SS: raw coin % move → direct P&L
      const coinChangePct = (coinPrice - entryRefPrice) / entryRefPrice;
      const isLong = getBetDirection(bet);
      pnlPct = coinChangePct * (isLong ? 1 : -1);
      currentPrice = Math.max(0.02, Math.min(0.98, bet.entryPrice + pnlPct * bet.entryPrice));
    } else {
      currentPrice = estimateContractPrice(bet, currentBtc);
      pnlPct = (currentPrice - bet.entryPrice) / bet.entryPrice;
    }

    // ── Trailing stop ──────────────────────────────────────────────────
    let trail = trailState.get(bet.marketConditionId);
    if (!trail) { trail = { peak: pnlPct }; trailState.set(bet.marketConditionId, trail); }
    if (pnlPct > trail.peak) trail.peak = pnlPct;
    if (trail.peak >= TRAIL_AT) trail.trailStop = trail.peak - TRAIL_PCT;

    // ── Exit decision ──────────────────────────────────────────────────
    const heldMs = bet.placedAt ? Date.now() - new Date(bet.placedAt).getTime() : 0;
    const timeExpired = ssMode && heldMs >= TIMEOUT_MS;

    let shouldExit = false, exitReason = "";

    if      (pnlPct >= TP_HIGH)                              { shouldExit = true; exitReason = "take_profit_max"; }
    else if (pnlPct >= TP_LOW)                               { shouldExit = true; exitReason = "take_profit"; }
    else if (trail.trailStop && pnlPct <= trail.trailStop)   { shouldExit = true; exitReason = "trail_stop"; }
    else if (pnlPct <= -STOP_LOSS)                           { shouldExit = true; exitReason = "stop_loss"; }
    else if (timeExpired)                                     { shouldExit = true; exitReason = "timeout"; }

    // ── Expiry check ───────────────────────────────────────────────────
    const endDate = bet.marketEndDateIso;
    if (endDate) {
      const msLeft = new Date(endDate) - Date.now();
      if (msLeft > 0 && msLeft < 90 * 1000 && pnlPct <= 0 && !shouldExit) {
        shouldExit = true; exitReason = "near_expiry";
      } else if (msLeft <= 0 && !shouldExit) {
        shouldExit = true; exitReason = "expiry";
        // Settle based on whether BTC moved in our direction
        const isLong = getBetDirection(bet);
        const btcWentUp = currentBtc && bet.entryBtcPrice && currentBtc > bet.entryBtcPrice;
        currentPrice = (isLong ? btcWentUp : !btcWentUp) ? 0.92 : 0.08;
      }
    }

    if (!shouldExit) {
      const btcMov = currentBtc && bet.entryBtcPrice
        ? ((currentBtc - bet.entryBtcPrice) / bet.entryBtcPrice * 100).toFixed(3) + "%"
        : "?%";
      const ssTag = bet.sharpShooter ? " ⚡" : "";
      console.log(`  📊 HOLD${ssTag} ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(0)}¢ now:${(currentPrice*100).toFixed(0)}¢ | ${pnlPct >= 0 ? "+" : ""}${(pnlPct*100).toFixed(2)}% | BTC cumulative:${btcMov}`);
      continue;
    }

    // ── Close bet ──────────────────────────────────────────────────────
    const isExpiry = exitReason === "expiry" || exitReason === "near_expiry";
    const exitPrice = currentPrice;
    const finalPnlPct = isExpiry
      ? (exitPrice - bet.entryPrice) / bet.entryPrice
      : pnlPct;
    const finalPnl = parseFloat((bet.betSize * finalPnlPct).toFixed(4));

    if (!isExpiry) {
      const icon = finalPnl > 0 ? "🟢" : finalPnl < 0 ? "🔴" : "⚪";
      const ssTag = bet.sharpShooter ? "⚡SS " : "";
      console.log(`  🎯 ${ssTag}EXIT [${exitReason.toUpperCase()}] ${bet.side} $${bet.betSize} | ${(bet.entryPrice*100).toFixed(0)}¢→${(exitPrice*100).toFixed(0)}¢ | ${finalPnl >= 0 ? "+" : ""}$${finalPnl.toFixed(4)} (${(finalPnlPct*100).toFixed(2)}%)`);
    } else {
      console.log(`  ⏱ EXPIRED ${bet.side} $${bet.betSize} | refunded (excluded from P&L)`);
    }

    const closeReason = isExpiry ? "expiry"
      : exitReason === "take_profit_max" ? "take_profit_max"
      : exitReason === "take_profit"     ? "take_profit"
      : exitReason === "trail_stop"      ? "trail_stop"
      : exitReason === "timeout"         ? "timeout"
      : "stop_loss";

    closeBet(bet.marketConditionId, { exitPrice, reason: closeReason, pnl: finalPnl });
    trailState.delete(bet.marketConditionId);
    exits.push({
      market: bet.marketQuestion, side: bet.side,
      pnlPct: finalPnlPct, pnl: finalPnl,
      reason: closeReason,
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
