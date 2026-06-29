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
         priceMarket, coinFromQuestion }                       from "./scalper.js";
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
const V_MAX_REAL_EDGE   = 0.15;  // >15¢ "edge" vs a REAL market = our feed/strike is wrong, not the market
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

// ── VALUE scoreboard: tracks record vs breakeven, real vs synthetic ──
const _srcByQ = new Map();   // question → true if real Polymarket market
const _rec = { w: 0, l: 0, sumFill: 0, pnl: 0, liveW: 0, liveL: 0, synW: 0, synL: 0 };

function trackValueExits(exits) {
  for (const e of exits) {
    if (!e.valueBet) continue;
    const fill = Math.min(0.97, (e.entryPrice || 0.5) + SLIPPAGE);
    _rec.sumFill += fill;
    _rec.pnl     += e.pnl;
    const isLive = _srcByQ.get((e.market || "").toLowerCase().trim()) === true;
    if (e.won) { _rec.w++; isLive ? _rec.liveW++ : _rec.synW++; }
    else       { _rec.l++; isLive ? _rec.liveL++ : _rec.synL++; }
  }
}

function printRecord() {
  const n = _rec.w + _rec.l;
  if (n === 0) return;
  const avgFill   = _rec.sumFill / n;
  const winRate   = (_rec.w / n) * 100;
  const breakeven = (1 / (1 + 0.98 * (1 / avgFill - 1))) * 100; // incl 2% fee
  const verdict   = winRate >= breakeven + 4 ? "✅ ABOVE" : winRate >= breakeven ? "⚠️ AT" : "🔻 BELOW";
  console.log(
    `  📈 VALUE record: ${_rec.w}W-${_rec.l}L (${winRate.toFixed(1)}%) | ` +
    `breakeven ${breakeven.toFixed(1)}% @ avg ${(avgFill*100).toFixed(0)}¢ ${verdict} | ` +
    `net $${_rec.pnl.toFixed(2)} | REAL-mkt: ${_rec.liveW}W-${_rec.liveL}L | synth: ${_rec.synW}W-${_rec.synL}L`
  );
}

function summary(exits, betsPlaced, maxConc) {
  const s = getStats();
  printRecord();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${maxConc} | P&L:$${s.pnl} | Scalps:${s.scalps} ──`);
}

// Preflight checks on first live run
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

export async function runScanCycle() {
  if (!botSettings.enabled) return { signals: null, exits: [], betsPlaced: 0 };

  if (!botSettings.dryRun) await ensureLiveReady();

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
    trackValueExits(exits);
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

      // Diversification: max 2 per coin (coin parsed from question text)
      const coin = coinFromQuestion(market.question) || (market.coin || "BTC").toUpperCase();
      const onCoin = getAllActiveBets().filter(b =>
        (coinFromQuestion(b.marketQuestion) || b.entryCoin || "BTC") === coin
      ).length;
      if (onCoin >= V_MAX_PER_COIN) continue;

      pricing = await priceMarket(market);
      if (!pricing) continue;
      const { probYes, strike, direction } = pricing;

      // ── REALISM LAYER ──────────────────────────────────────────────
      // Synthetic markets have static prices, which hands the bot fantasy
      // fills (buying 90¢-fair contracts at 62¢). Real Polymarket MMs run
      // the same Black-Scholes and quote at fair + spread. So: reprice
      // every synthetic token the way a real MM would — fair value plus a
      // 1.5¢ half-spread plus small quote noise. The bot now only enters
      // when it catches a genuinely stale/mispriced quote, which is the
      // only edge that exists live. Real CLOB markets (0x... ids) are
      // never touched.
      const isSynthetic = !/^0x[0-9a-f]{40,}/i.test(String(id || ""));
      if (isSynthetic) {
        for (const token of market.tokens || []) {
          const sn = (token.outcome || "").toUpperCase();
          if (sn !== "YES" && sn !== "NO") continue;
          const fairSide  = sn === "YES" ? probYes : 1 - probYes;
          const halfSpread = 0.015;
          // Irwin-Hall noise: mean 0, σ ≈ 2¢, rare ±8-10¢ tails = stale quotes
          const noise = ((Math.random() + Math.random() + Math.random() + Math.random()) - 2) / 2 * 0.10;
          token.price = Math.min(0.97, Math.max(0.03, fairSide + halfSpread + noise));
        }
      }

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
      if (market.live === true && best.edge > V_MAX_REAL_EDGE) {
        console.log(`    ⚠️ +${(best.edge*100).toFixed(0)}¢ edge vs REAL market — too good to be true, skipping | ${market.question.slice(0, 45)}`);
        continue;
      }
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
      
      // Live balance check (update every entry)
      let currentBalance = balance;
      if (!botSettings.dryRun) {
        try {
          const { getWalletBalance } = await import("./live-clob.js");
          const liveBal = await getWalletBalance(
            process.env.POLYMARKET_API_KEY,
            process.env.POLYMARKET_PRIVATE_KEY
          );
          if (liveBal !== null && liveBal > 0) {
            currentBalance = liveBal;
            const maxEnv = parseFloat(process.env.MAX_BET_SIZE || "10");
            if (liveBal < maxEnv) {
              console.log(`    ⚠️  Wallet balance $${liveBal.toFixed(2)} < MAX_BET_SIZE $${maxEnv}, skipping`);
              continue;
            }
          }
        } catch (err) {
          // Balance check failed, use env fallback
        }
      }
      
      const maxEnv = parseFloat(process.env.MAX_BET_SIZE || "10");
      finalBet = parseFloat(Math.min(
        Math.max(currentBalance * fStar * V_KELLY_FRACTION, V_MIN_BET),
        V_MAX_BET, maxEnv, currentBalance * 0.15
      ).toFixed(2));
      if (currentBalance < finalBet || finalBet < V_MIN_BET) continue;

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
        entryCoin:          pricing?.coin ?? (market.coin || "BTC"),
        sharpShooter:       SS_MODE,
        valueBet:           VALUE_MODE,
        strike:             pricing?.strike    ?? null,
        direction:          pricing?.direction ?? null,
      });
      betsPlaced++;
      if (VALUE_MODE) _srcByQ.set(q, market.live === true);

      const tag = VALUE_MODE ? "🎯VALUE" : SS_MODE ? "⚡SHARP" : signals.activeStrategy;
      console.log(`  ✅ ENTRY ${decision.side} $${finalBet} @ ${(entryPrice*100).toFixed(1)}¢ | ${minsLeft}min | ${tag} | ${decision.reasoning || ""} | ${market.question?.slice(0,45)}`);
    } catch (err) {
      console.error(`  ❌ Order failed: ${err.message}`);
    }
  }

  summary(exits, betsPlaced, MAX_CONC);
  return { signals, exits, betsPlaced };
}