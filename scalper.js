/**
 * scalper.js — PolyBettor exit engine
 *
 * REALISTIC simulation of Polymarket binary prediction markets.
 *
 * How Polymarket actually works:
 * ─────────────────────────────
 * 1. You buy YES or NO shares at a price P (e.g. 0.60 = 60¢)
 * 2. Each share pays $1.00 if your side wins at expiry, $0 if it loses
 * 3. Profit if win: (1/P - 1) * betSize  e.g. $10 @ 60¢ → +$6.67 gross
 * 4. Polymarket fee: 2% of gross profit only
 * 5. Fill slippage: ~0.5¢ above displayed price (market order spread)
 *
 * Contract repricing (mid-market) between entry and expiry:
 * ─────────────────────────────────────────────────────────
 * The market price of a contract reflects the current probability
 * the condition will be met. A contract like "Will BTC be above $63,500
 * in 30 min?" starting at 60¢ means the market thinks there's a 60%
 * chance BTC reaches $63,500 in the next 30 min.
 *
 * The Black-Scholes style formula for a binary:
 *   P(hit) = N(d) where d = (ln(S/K) + 0.5*σ²*T) / (σ*√T)
 *   N = normal CDF, S = spot, K = target, T = time remaining (years)
 *   σ = annualized vol
 *
 * This gives realistic repricing: small BTC moves barely change price
 * on long-dated contracts, but strongly affect near-expiry contracts.
 *
 * Pre-expiry exit: sell at mid price (fair value) minus 0.5¢ spread
 * Stop loss: if contract value drops 50%+ from entry (we're very wrong)
 * Take profit: if contract value rises 80%+ above entry (we're very right)
 *              OR at timeout after 3 min → binary resolution
 *
 * Binary resolution at timeout: 
 * Based on whether coin actually crossed the target, with realistic
 * probability. Not deterministic — variance matches real markets.
 */
import axios from "axios";
import { getAllActiveBets, closeBet } from "./state.js";

const POLYMARKET_FEE = 0.02;  // 2% fee on gross winnings
const SLIPPAGE       = 0.005; // 0.5¢ spread on fills

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

// Normal CDF approximation (Abramowitz & Stegun)
function normalCDF(x) {
  const a = 0.2316419, b1 = 0.319381530, b2 = -0.356563782,
        b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const t = 1 / (1 + a * Math.abs(x));
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const n = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x) * poly;
  return x >= 0 ? n : 1 - n;
}

/**
 * Black-Scholes binary call probability: P(S_T > K) at time T
 * Returns probability that spot price exceeds target by expiry.
 *
 * Annualized vols by coin (realistic 30-day realized vol):
 * BTC ~80%, ETH ~100%, SOL ~150%, BNB ~100%, XRP ~120%, DOGE ~180%
 */
const ANNUAL_VOL = { BTC: 0.80, ETH: 1.00, SOL: 1.50, BNB: 1.00, XRP: 1.20, DOGE: 1.80 };

function binaryCallProb(spot, target, timeRemainingMs, coin) {
  if (!spot || !target || timeRemainingMs <= 0) return 0.5;
  const T = Math.max(timeRemainingMs, 30000) / (365.25 * 24 * 3600 * 1000); // years
  const sigma = ANNUAL_VOL[(coin || "BTC").toUpperCase()] || 0.80;
  const lnSK = Math.log(spot / target);
  const d2 = (lnSK - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return normalCDF(d2);
}

/**
 * Get current fair value of THIS bet given current coin price and time left.
 * Uses proper Black-Scholes binary pricing.
 */
function getContractFairValue(bet, currentCoinPrice) {
  if (!currentCoinPrice || !bet.entryPrice) return bet.entryPrice;

  const q = (bet.marketQuestion || "").toLowerCase();
  const priceMatch = q.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
  const targetPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;
  if (!targetPrice) return bet.entryPrice;

  const msLeft = bet.marketEndDateIso
    ? new Date(bet.marketEndDateIso) - Date.now()
    : 30 * 60 * 1000; // default 30 min

  const coin = (bet.entryCoin || "BTC").toUpperCase();

  // Probability of price going above target
  const probAbove = binaryCallProb(currentCoinPrice, targetPrice, msLeft, coin);

  // Direction of question
  const isBullQ = q.includes("rise above") || q.includes("above") ||
                  q.includes("reach") || q.includes("hit") || q.includes("be above");
  const isBearQ = q.includes("drop below") || q.includes("fall below") || q.includes("below");

  let probYes;
  if (isBullQ)      probYes = probAbove;
  else if (isBearQ) probYes = 1 - probAbove;
  else              probYes = probAbove; // ATM: just direction

  // Fair value of our side
  const fairValue = bet.side === "YES" ? probYes : (1 - probYes);
  return Math.max(0.02, Math.min(0.98, fairValue));
}

/**
 * Calculate P&L for a resolved bet.
 * win=true: payout = shares * $1, profit = payout - stake, net = profit * (1 - fee)
 * win=false: payout = 0, net = -stake
 */
function calcPnl(bet, won) {
  const fillPrice = Math.min(0.97, bet.entryPrice + SLIPPAGE);
  const shares    = bet.betSize / fillPrice;
  if (won) {
    const gross = shares - bet.betSize;
    return parseFloat((gross * (1 - POLYMARKET_FEE)).toFixed(4));
  }
  return parseFloat((-bet.betSize).toFixed(4));
}

/**
 * Pre-expiry exit P&L: sell at current fair value minus spread.
 */
function calcPreExitPnl(bet, fairValue) {
  const fillPrice  = Math.min(0.97, bet.entryPrice + SLIPPAGE);
  const sellPrice  = Math.max(0.02, fairValue - SLIPPAGE);
  const shares     = bet.betSize / fillPrice;
  const gross      = shares * sellPrice - bet.betSize;
  const fee        = gross > 0 ? gross * POLYMARKET_FEE : 0;
  return { pnl: parseFloat((gross - fee).toFixed(4)), exitPrice: sellPrice };
}

export async function checkScalpExits(markets, signals, dryRun = true, ssMode = false) {
  const active = getAllActiveBets();
  if (active.length === 0) return { exits: [], currentBtc: null };

  const prices     = await getLivePrices();
  const currentBtc = prices.BTC || null;

  const TIMEOUT_MS  = ssMode ? 3 * 60 * 1000 : Infinity;
  // Only exit early if contract value moves dramatically
  const TP_THRESHOLD = 0.80;  // fair value 80%+ above entry price = strong win signal
  const SL_THRESHOLD = 0.50;  // fair value 50%+ below entry price = cut losses

  const exits = [];

  for (const bet of active) {
    if (!bet.entryPrice) continue;

    const coinPrice = getCoinPrice(prices, bet.entryCoin || "BTC");
    const heldMs    = bet.placedAt ? Date.now() - new Date(bet.placedAt).getTime() : 0;
    const fairValue = getContractFairValue(bet, coinPrice);
    const valueChangePct = (fairValue - bet.entryPrice) / bet.entryPrice;

    // Expiry check
    const endDate = bet.marketEndDateIso;
    const msLeft  = endDate ? new Date(endDate) - Date.now() : Infinity;

    let shouldExit = false, exitReason = "";

    if (msLeft <= 0) {
      shouldExit = true; exitReason = "expiry";
    } else if (msLeft < 60 * 1000 && valueChangePct < 0) {
      // Near expiry and we're losing — cut it
      shouldExit = true; exitReason = "near_expiry";
    } else if (valueChangePct >= TP_THRESHOLD) {
      // Contract has repriced strongly in our favor — take profit early
      shouldExit = true; exitReason = "take_profit";
    } else if (valueChangePct <= -SL_THRESHOLD) {
      // Contract has moved hard against us — stop out
      shouldExit = true; exitReason = "stop_loss";
    } else if (ssMode && heldMs >= TIMEOUT_MS) {
      shouldExit = true; exitReason = "timeout";
    }

    if (!shouldExit) {
      const coinMov = coinPrice && bet.entryBtcPrice
        ? ((coinPrice - bet.entryBtcPrice) / bet.entryBtcPrice * 100).toFixed(3) + "%"
        : "?%";
      const ssTag = bet.sharpShooter ? " ⚡" : "";
      const coin  = (bet.entryCoin || "BTC").padEnd(4);
      console.log(`  📊 HOLD${ssTag} ${coin} ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(0)}¢ fair:${(fairValue*100).toFixed(0)}¢ | Δ${valueChangePct >= 0 ? "+" : ""}${(valueChangePct*100).toFixed(1)}% | coin:${coinMov}`);
      continue;
    }

    // ── Resolve ──────────────────────────────────────────────────────
    let finalPnl, exitPrice, won;

    if (exitReason === "take_profit" || exitReason === "stop_loss" || exitReason === "near_expiry") {
      // Pre-expiry exit at current market price
      const res = calcPreExitPnl(bet, fairValue);
      finalPnl  = res.pnl;
      exitPrice = res.exitPrice;
      won       = finalPnl > 0;
    } else {
      // Expiry or timeout: binary resolution based on actual coin price vs target
      // Use fair value as the probability our side wins (stochastic)
      won      = Math.random() < fairValue;
      finalPnl = calcPnl(bet, won);
      exitPrice = won ? 0.97 : 0.03;
    }

    const icon   = finalPnl > 0 ? "🟢" : finalPnl < 0 ? "🔴" : "⚪";
    const result = won ? "WIN" : "LOSS";
    const ssTag  = bet.sharpShooter ? "⚡SS " : "";
    const coin   = (bet.entryCoin || "BTC").padEnd(4);
    const fillP  = Math.min(0.97, bet.entryPrice + SLIPPAGE);
    const shares = (bet.betSize / fillP).toFixed(2);
    console.log(`  🎯 ${ssTag}EXIT [${exitReason.toUpperCase()}] ${icon} ${result} | ${coin} ${bet.side} $${bet.betSize} (${shares}sh @ ${(fillP*100).toFixed(1)}¢) | ${finalPnl >= 0 ? "+" : ""}$${finalPnl.toFixed(2)} | fair:${(fairValue*100).toFixed(0)}¢`);

    const closeReason = ["take_profit","stop_loss","expiry","timeout","near_expiry"].includes(exitReason)
      ? exitReason : "timeout";

    closeBet(bet.marketConditionId, { exitPrice, reason: closeReason, pnl: finalPnl });
    exits.push({
      market: bet.marketQuestion, side: bet.side,
      pnl: finalPnl, won, reason: closeReason,
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
