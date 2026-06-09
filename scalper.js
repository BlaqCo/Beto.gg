/**
 * scalper.js — PolyBettor exit engine (SharpShooter optimized)
 *
 * PROFIT MODEL (synthetic markets):
 * Each bet is a binary prediction. At timeout/expiry we check if the
 * coin actually moved in the predicted direction. If YES → win at
 * payout odds. If NO → lose the bet. This mirrors real Polymarket resolution.
 *
 * Example: bet NO @ 60¢ on "Will BTC rise above $63,500?"
 *   → BTC stays below $63,500 at timeout → NO wins → payout = $10/0.60 = $16.67 → profit $6.67
 *   → BTC rises above $63,500 → NO loses → -$10
 *
 * For SS mode we use a 3-minute hold then resolve based on coin direction.
 * This produces real wins/losses instead of perpetual $0.00.
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
  _priceCache = { ..._priceCache, ...Object.fromEntries(Object.entries(p).filter(([,v]) => v)) };
  _priceFetchTime = Date.now();
  return _priceCache;
}

function getCoinPrice(prices, coin) {
  return prices[(coin || "BTC").toUpperCase()] || prices.BTC || null;
}

/**
 * Determine if this bet is currently WINNING based on coin movement.
 * We parse the market question to figure out the target price and direction,
 * then compare against current coin price.
 */
function resolveBet(bet, currentCoinPrice) {
  const q = (bet.marketQuestion || "").toLowerCase();
  const side = bet.side; // "YES" or "NO"

  // Extract target price from question (e.g. "$63,500" → 63500)
  const priceMatch = q.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
  const targetPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;

  if (!targetPrice || !currentCoinPrice || !bet.entryBtcPrice) return null;

  // Determine question direction
  const isBullQ = q.includes("rise above") || q.includes("above") ||
                  q.includes("reach") || q.includes("hit") ||
                  q.includes("higher") || (q.includes("be above"));
  const isBearQ = q.includes("drop below") || q.includes("fall below") ||
                  q.includes("below") || q.includes("drop");

  // Has the condition been met?
  let conditionMet = false;
  if (isBullQ)      conditionMet = currentCoinPrice >= targetPrice;
  else if (isBearQ) conditionMet = currentCoinPrice <= targetPrice;
  else {
    // ATM: "be above current price" — just check direction
    conditionMet = currentCoinPrice > bet.entryBtcPrice;
  }

  // Did our side win?
  const weWin = (side === "YES" && conditionMet) || (side === "NO" && !conditionMet);
  return weWin;
}

export async function checkScalpExits(markets, signals, dryRun = true, ssMode = false) {
  const active = getAllActiveBets();
  if (active.length === 0) return { exits: [], currentBtc: null };

  const prices    = await getLivePrices();
  const currentBtc = prices.BTC || null;

  // ── Thresholds ────────────────────────────────────────────────────────────
  const TIMEOUT_MS  = ssMode ? 3 * 60 * 1000 : Infinity; // 3 min SS timeout
  const STOP_LOSS_PCT = ssMode ? 0.012 : parseFloat(process.env.STOP_LOSS || "0.15");
  // In binary resolution mode, we don't use TP_LOW/TP_HIGH —
  // win/loss is determined by whether the prediction came true.

  const exits = [];

  for (const bet of active) {
    if (!bet.entryPrice) continue;

    const coinPrice  = getCoinPrice(prices, bet.entryCoin || "BTC");
    const heldMs     = bet.placedAt ? Date.now() - new Date(bet.placedAt).getTime() : 0;
    const timeExpired = ssMode && heldMs >= TIMEOUT_MS;

    // ── Coin move P&L (for stop-loss and hold display) ──────────────────
    let coinChangePct = 0;
    if (coinPrice && bet.entryBtcPrice) {
      coinChangePct = (coinPrice - bet.entryBtcPrice) / bet.entryBtcPrice;
    }

    // Direction-aware P&L for stop loss
    const q = (bet.marketQuestion || "").toLowerCase();
    const isBullQ = q.includes("rise above") || q.includes("above") || q.includes("reach") || q.includes("hit");
    const isBearQ = q.includes("drop below") || q.includes("fall below") || q.includes("below");
    const isLong  = isBullQ ? bet.side === "YES" : bet.side === "NO";
    const directedPnlPct = coinChangePct * (isLong ? 1 : -1);

    // ── Stop loss: cut early if coin moving hard against us ──────────────
    let shouldExit = false, exitReason = "";

    if (directedPnlPct <= -STOP_LOSS_PCT) {
      shouldExit = true;
      exitReason = "stop_loss";
    } else if (timeExpired) {
      shouldExit = true;
      exitReason = "timeout";
    }

    // ── Expiry check ────────────────────────────────────────────────────
    const endDate = bet.marketEndDateIso;
    if (endDate) {
      const msLeft = new Date(endDate) - Date.now();
      if (msLeft <= 0 && !shouldExit) {
        shouldExit = true;
        exitReason = "expiry";
      } else if (msLeft > 0 && msLeft < 60 * 1000 && !shouldExit) {
        shouldExit = true;
        exitReason = "near_expiry";
      }
    }

    if (!shouldExit) {
      const coinMov = coinPrice && bet.entryBtcPrice
        ? ((coinPrice - bet.entryBtcPrice) / bet.entryBtcPrice * 100).toFixed(3) + "%"
        : "?%";
      const ssTag = bet.sharpShooter ? " ⚡" : "";
      const coin  = (bet.entryCoin || "BTC").padEnd(4);
      console.log(`  📊 HOLD${ssTag} ${coin} ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(0)}¢ | coin move:${coinMov} | ${directedPnlPct >= 0 ? "+" : ""}${(directedPnlPct*100).toFixed(2)}%`);
      continue;
    }

    // ── Resolve: did we win? ─────────────────────────────────────────────
    let finalPnl, exitPrice, won;

    if (exitReason === "stop_loss") {
      // Hard stop — lose the bet
      won      = false;
      exitPrice = 0.05;
      finalPnl  = parseFloat((-bet.betSize * 0.85).toFixed(4)); // lose ~85%
    } else {
      // Timeout/expiry: resolve based on whether prediction came true
      won = resolveBet(bet, coinPrice);

      if (won === null) {
        // Can't determine — treat as push
        exitPrice = bet.entryPrice;
        finalPnl  = 0;
      } else if (won) {
        // WIN: payout = betSize / entryPrice (binary resolution)
        const payout = bet.betSize / bet.entryPrice;
        finalPnl     = parseFloat((payout - bet.betSize).toFixed(4));
        exitPrice    = 0.95;
      } else {
        // LOSS: lose full bet
        finalPnl  = parseFloat((-bet.betSize).toFixed(4));
        exitPrice = 0.05;
      }
    }

    const icon   = finalPnl > 0 ? "🟢" : finalPnl < 0 ? "🔴" : "⚪";
    const ssTag  = bet.sharpShooter ? "⚡SS " : "";
    const coin   = (bet.entryCoin || "BTC").padEnd(4);
    const result = won === true ? "WIN" : won === false ? "LOSS" : "PUSH";
    console.log(`  🎯 ${ssTag}EXIT [${exitReason.toUpperCase()}] ${icon} ${result} | ${coin} ${bet.side} $${bet.betSize} | ${finalPnl >= 0 ? "+" : ""}$${finalPnl.toFixed(2)} @ ${(bet.entryPrice*100).toFixed(0)}¢`);

    const closeReason = exitReason === "stop_loss" ? "stop_loss"
      : exitReason === "expiry" || exitReason === "near_expiry" ? "expiry"
      : "timeout";

    closeBet(bet.marketConditionId, { exitPrice, reason: closeReason, pnl: finalPnl });
    exits.push({
      market: bet.marketQuestion, side: bet.side,
      pnl: finalPnl, won,
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
