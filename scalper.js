/**
 * scalper.js — PolyBettor exit engine
 *
 * REALISTIC DRY RUN MODEL:
 * Mirrors real Polymarket behavior as closely as possible so live mode
 * performs identically to dry run.
 *
 * Real Polymarket mechanics:
 * - Binary resolution: contract pays $1 if YES, $0 if NO at expiry
 * - You buy YES @ 0.60 → if YES wins, payout = $1/share → profit = $0.40/share
 * - You buy NO  @ 0.60 → if NO  wins, payout = $1/share → profit = $0.40/share
 * - Polymarket fee: 2% of WINNINGS only (not stake)
 * - Fill price: entry price + 0.5¢ slippage (market order spread)
 * - Pre-expiry exit: you can sell at current market price (mid of bid/ask)
 *   but market makers reprice based on probability → modeled via Bayesian update
 * - Resolution: based on whether coin crossed the target price by expiry
 *   using a realistic probability model (not certain — just more likely if bias correct)
 *
 * IMPORTANT: In dry run, wins/losses reflect EXPECTED value given the signal.
 * The bot has edge only if its bias is correct more than the market implies.
 * At 60¢ entry, market says 60% chance YES wins. Bot needs >60% accuracy to profit.
 */
import axios from "axios";
import { getAllActiveBets, closeBet } from "./state.js";

const POLYMARKET_FEE = 0.02;   // 2% fee on winnings
const SLIPPAGE       = 0.005;  // 0.5¢ average fill slippage

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
 * Estimate current fair value of this contract given coin movement so far.
 * Models how market makers would reprice based on Bayesian probability update.
 *
 * For "Will COIN be above $X in T minutes?":
 * - If coin is already above X → YES probability rises sharply
 * - If coin is well below X → YES probability falls
 * - Uses a sigmoid model based on distance from target relative to volatility
 */
function estimateFairValue(bet, currentCoinPrice) {
  if (!currentCoinPrice || !bet.entryBtcPrice || !bet.entryPrice) return bet.entryPrice;

  const q = (bet.marketQuestion || "").toLowerCase();
  const priceMatch = q.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
  if (!priceMatch) return bet.entryPrice;
  const targetPrice = parseFloat(priceMatch[1].replace(/,/g, ""));

  // Distance from target as % of current price
  const distPct = (currentCoinPrice - targetPrice) / targetPrice;

  // Volatility assumption per coin (annualized vol / sqrt(year/minutes))
  // For 30-min window, typical BTC vol = ~0.3% per 30min
  const coinVols = { BTC: 0.003, ETH: 0.005, SOL: 0.008, BNB: 0.005, XRP: 0.008, DOGE: 0.012 };
  const vol = coinVols[(bet.entryCoin || "BTC").toUpperCase()] || 0.003;

  // Time remaining factor (decays as expiry approaches)
  const heldMs = bet.placedAt ? Date.now() - new Date(bet.placedAt).getTime() : 0;
  const endMs  = bet.marketEndDateIso ? new Date(bet.marketEndDateIso) - Date.now() : 30 * 60000;
  const totalMs = heldMs + Math.max(endMs, 0);
  const timeFrac = totalMs > 0 ? Math.max(endMs, 0) / totalMs : 0;
  const effectiveVol = vol * Math.sqrt(timeFrac + 0.01); // avoid zero

  // Probability YES wins = sigmoid of (currentPrice - target) / (target * effectiveVol)
  const z = distPct / effectiveVol;
  const probYes = 1 / (1 + Math.exp(-z * 2.5)); // sigmoid, scaled

  // Is this a YES or NO question direction?
  const isBullQ = q.includes("rise above") || q.includes("above") ||
                  q.includes("reach") || q.includes("hit") || q.includes("be above");
  const isBearQ = q.includes("drop below") || q.includes("fall below") || q.includes("below");

  let fairValue;
  if (isBullQ) {
    fairValue = bet.side === "YES" ? probYes : (1 - probYes);
  } else if (isBearQ) {
    fairValue = bet.side === "NO" ? probYes : (1 - probYes); // NO on bearish = YES prob
  } else {
    // ATM: simple direction
    const probUp = 0.5 + (distPct / effectiveVol) * 0.15;
    fairValue = bet.side === "YES" ? Math.max(0.02, Math.min(0.98, probUp))
                                   : Math.max(0.02, Math.min(0.98, 1 - probUp));
  }

  return Math.max(0.02, Math.min(0.98, fairValue));
}

/**
 * Resolve binary outcome at expiry/timeout.
 * Returns true (YES wins) or false (NO wins).
 * Uses probabilistic resolution — not deterministic — to match real variance.
 */
function resolveOutcome(bet, currentCoinPrice) {
  const q = (bet.marketQuestion || "").toLowerCase();
  const priceMatch = q.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
  const targetPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;

  if (!targetPrice || !currentCoinPrice || !bet.entryBtcPrice) {
    // No data → coin flip
    return Math.random() > 0.5;
  }

  // Compute fair probability of YES winning right now
  const fairValue = estimateFairValue(bet, currentCoinPrice);
  const q2 = (bet.marketQuestion || "").toLowerCase();
  const isBullQ = q2.includes("rise above") || q2.includes("above") ||
                  q2.includes("reach") || q2.includes("hit") || q2.includes("be above");

  // probYes = fair value of YES side
  let probYes;
  if (isBullQ) {
    probYes = bet.side === "YES" ? fairValue : 1 - fairValue;
  } else {
    probYes = bet.side === "NO" ? fairValue : 1 - fairValue;
  }

  // Stochastic resolution: YES wins with probability = probYes
  // This means over many bets, win rate = accuracy of the signal
  const yesWins = Math.random() < probYes;

  // Did OUR side win?
  return (bet.side === "YES" && yesWins) || (bet.side === "NO" && !yesWins);
}

/**
 * Calculate realistic P&L for a resolved bet.
 * Mirrors Polymarket's actual payout structure.
 *
 * If you buy X shares @ entryPrice:
 *   shares = betSize / (entryPrice + slippage)
 *   WIN:  payout = shares * 1.00, gross_profit = payout - betSize, net = gross * (1 - fee)
 *   LOSS: payout = 0, net = -betSize
 */
function calcPnl(bet, won) {
  const fillPrice = Math.min(0.97, bet.entryPrice + SLIPPAGE);
  const shares    = bet.betSize / fillPrice;

  if (won) {
    const grossProfit = shares - bet.betSize;          // payout $1/share minus stake
    const fee         = grossProfit * POLYMARKET_FEE;  // 2% of winnings
    return parseFloat((grossProfit - fee).toFixed(4));
  } else {
    return parseFloat((-bet.betSize).toFixed(4));
  }
}

export async function checkScalpExits(markets, signals, dryRun = true, ssMode = false) {
  const active = getAllActiveBets();
  if (active.length === 0) return { exits: [], currentBtc: null };

  const prices     = await getLivePrices();
  const currentBtc = prices.BTC || null;

  // Timeout: 3 min for SS — after this we resolve the bet as if it expired
  const TIMEOUT_MS    = ssMode ? 3 * 60 * 1000 : Infinity;
  // Stop loss: exit early if fair value of our position drops >40% from entry
  const STOP_LOSS_THRESHOLD = 0.40; // 40% fair value drop = exit

  const exits = [];

  for (const bet of active) {
    if (!bet.entryPrice) continue;

    const coinPrice = getCoinPrice(prices, bet.entryCoin || "BTC");
    const heldMs    = bet.placedAt ? Date.now() - new Date(bet.placedAt).getTime() : 0;

    // Current fair value of our position
    const fairValue  = estimateFairValue(bet, coinPrice);
    const valueChange = (fairValue - bet.entryPrice) / bet.entryPrice; // % change in position value

    // ── Exit conditions ────────────────────────────────────────────────
    let shouldExit = false, exitReason = "";

    // 1. Take profit: fair value risen 50%+ above entry (position repriced in our favor)
    if (valueChange >= 0.50) {
      shouldExit = true; exitReason = "take_profit";
    }
    // 2. Stop loss: fair value dropped 40%+ below entry
    else if (valueChange <= -STOP_LOSS_THRESHOLD) {
      shouldExit = true; exitReason = "stop_loss";
    }
    // 3. Timeout: resolve as binary outcome
    else if (ssMode && heldMs >= TIMEOUT_MS) {
      shouldExit = true; exitReason = "timeout";
    }

    // 4. Expiry check
    const endDate = bet.marketEndDateIso;
    if (endDate) {
      const msLeft = new Date(endDate) - Date.now();
      if (msLeft <= 0 && !shouldExit) {
        shouldExit = true; exitReason = "expiry";
      } else if (msLeft > 0 && msLeft < 60 * 1000 && !shouldExit) {
        shouldExit = true; exitReason = "near_expiry";
      }
    }

    if (!shouldExit) {
      const coinMov = coinPrice && bet.entryBtcPrice
        ? ((coinPrice - bet.entryBtcPrice) / bet.entryBtcPrice * 100).toFixed(3) + "%"
        : "?%";
      const ssTag = bet.sharpShooter ? " ⚡" : "";
      const coin  = (bet.entryCoin || "BTC").padEnd(4);
      console.log(`  📊 HOLD${ssTag} ${coin} ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(0)}¢ fair:${(fairValue*100).toFixed(0)}¢ | Δ${valueChange >= 0 ? "+" : ""}${(valueChange*100).toFixed(1)}% | coin:${coinMov}`);
      continue;
    }

    // ── Resolve P&L ────────────────────────────────────────────────────
    let finalPnl, won, exitPrice;

    if (exitReason === "take_profit" || exitReason === "stop_loss") {
      // Pre-expiry exit: sell at current fair value (minus 0.5¢ spread)
      const sellPrice  = Math.max(0.02, fairValue - SLIPPAGE);
      const shares     = bet.betSize / Math.min(0.97, bet.entryPrice + SLIPPAGE);
      const grossProfit = shares * sellPrice - bet.betSize;
      const fee        = grossProfit > 0 ? grossProfit * POLYMARKET_FEE : 0;
      finalPnl  = parseFloat((grossProfit - fee).toFixed(4));
      exitPrice = sellPrice;
      won       = finalPnl > 0;
    } else {
      // Timeout/expiry: binary resolution
      won       = resolveOutcome(bet, coinPrice);
      finalPnl  = calcPnl(bet, won);
      exitPrice = won ? 0.97 : 0.03;
    }

    const icon   = finalPnl > 0 ? "🟢" : finalPnl < 0 ? "🔴" : "⚪";
    const result = won ? "WIN" : "LOSS";
    const ssTag  = bet.sharpShooter ? "⚡SS " : "";
    const coin   = (bet.entryCoin || "BTC").padEnd(4);
    const fillP  = Math.min(0.97, bet.entryPrice + SLIPPAGE);
    const shares = (bet.betSize / fillP).toFixed(2);
    console.log(`  🎯 ${ssTag}EXIT [${exitReason.toUpperCase()}] ${icon} ${result} | ${coin} ${bet.side} $${bet.betSize} (${shares} shares @ ${(fillP*100).toFixed(1)}¢) | ${finalPnl >= 0 ? "+" : ""}$${finalPnl.toFixed(2)} | fair:${(fairValue*100).toFixed(0)}¢`);

    const closeReason = ["take_profit","stop_loss","expiry","timeout"].includes(exitReason)
      ? exitReason : "timeout";

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
