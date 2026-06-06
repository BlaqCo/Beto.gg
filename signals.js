/**
 * signals.js — 3-Strategy Scalping Engine
 *
 * Strategy A: RSI_EMA    — RSI(14) + EMA 9/21 crossover (momentum)
 * Strategy B: WALL       — Order book bid/ask wall detection (timing)
 * Strategy C: BREAKOUT   — ATR volatility breakout + momentum burst
 *
 * Auto mode: bot picks best strategy based on market conditions
 */

import axios from "axios";

// ── Price Sources ──────────────────────────────────────────────
// Primary: Chainlink on-chain (same oracle Polymarket settles on)
const CHAINLINK_RPC = "https://polygon-rpc.com";
const CHAINLINK_BTC = "0xc907E116054Ad103354f2D350FD2514433D57F6F";

async function fetchChainlink() {
  const { data } = await axios.post(CHAINLINK_RPC, {
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: CHAINLINK_BTC, data: "0xfeaf968c" }, "latest"],
  }, { timeout: 5000 });
  if (!data.result || data.result === "0x") throw new Error("Empty");
  return Number(BigInt("0x" + data.result.slice(66, 130))) / 1e8;
}

async function fetchKrakenTicker() {
  const { data } = await axios.get("https://api.kraken.com/0/public/Ticker", {
    params: { pair: "XBTUSD" }, timeout: 6000,
  });
  const t = data.result?.XXBTZUSD;
  if (!t) throw new Error("No ticker");
  const last = parseFloat(t.c[0]);
  return {
    price: last,
    bid: parseFloat(t.b[0]),
    ask: parseFloat(t.a[0]),
    high: parseFloat(t.h[1]),
    low: parseFloat(t.l[1]),
    volume: parseFloat(t.v[1]),
    priceChangePercent: ((last - parseFloat(t.o)) / parseFloat(t.o)) * 100,
  };
}

async function fetchKrakenOHLC() {
  const { data } = await axios.get("https://api.kraken.com/0/public/OHLC", {
    params: { pair: "XBTUSD", interval: 15 }, timeout: 8000,
  });
  return (data.result?.XXBTZUSD || []).slice(-100).map(c => ({
    time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
    low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[6]),
  }));
}

export async function fetchOrderBook(depth = 150) {
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Depth", {
      params: { pair: "XBTUSD", count: depth }, timeout: 6000,
    });
    const b = data.result?.XXBTZUSD;
    if (!b) return null;
    return {
      bids: b.bids.map(x => ({ price: parseFloat(x[0]), size: parseFloat(x[1]) })),
      asks: b.asks.map(x => ({ price: parseFloat(x[0]), size: parseFloat(x[1]) })),
    };
  } catch { return null; }
}

export async function fetchCurrentPrice() {
  try { const p = await fetchChainlink(); if (p > 1000) return p; } catch {}
  const t = await fetchKrakenTicker();
  return t.price;
}

export async function fetch24hStats() {
  return fetchKrakenTicker();
}

// ── Indicators ─────────────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag*(period-1) + Math.max(d,0)) / period;
    al = (al*(period-1) + Math.max(-d,0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag/al);
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length-1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a,b) => a+b) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i]*k + ema*(1-k);
  return ema;
}

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high-c.low, Math.abs(c.high-candles[i].close), Math.abs(c.low-candles[i].close))
  );
  return trs.slice(-period).reduce((a,b) => a+b) / period;
}

// ── Strategy A: RSI + EMA ─────────────────────────────────────
// Best for: trending markets with clear momentum
// Signal: RSI direction + EMA crossover alignment

export function strategyRSI_EMA(closes, atr) {
  const rsi = calcRSI(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const price = closes[closes.length - 1];

  // RSI score
  const rsiScore = rsi < 30 ? 1 : rsi < 40 ? 0.6 : rsi < 45 ? 0.25 :
                   rsi > 70 ? -1 : rsi > 60 ? -0.6 : rsi > 55 ? -0.25 : (50-rsi)/50;

  // EMA crossover strength
  const emaDiff = (ema9 - ema21) / ema21;
  const emaScore = Math.max(-1, Math.min(1, emaDiff * 120));

  // Alignment check: both agreeing = higher confidence
  const aligned = (rsiScore > 0 && emaScore > 0) || (rsiScore < 0 && emaScore < 0);
  const bias = rsiScore * 0.45 + emaScore * 0.55;
  const confidence = aligned ? Math.min(0.92, Math.abs(bias) * 1.4) : Math.abs(bias) * 0.5;

  return {
    name: "RSI_EMA",
    bias: Math.max(-1, Math.min(1, bias)),
    confidence,
    rsi, ema9, ema21,
    components: { rsiScore, emaScore },
    meta: `RSI:${rsi.toFixed(0)} EMA9${ema9>ema21?'>':'<'}EMA21 aligned:${aligned}`,
  };
}

// ── Strategy B: Order Book Wall ───────────────────────────────
// Best for: ranging/choppy markets, precision timing
// Signal: large bid/ask walls as support/resistance

export function strategyWall(book, price) {
  if (!book) return { name: "WALL", bias: 0, confidence: 0, meta: "No book data", components: {} };

  const bucket = price * 0.0015; // 0.15% buckets
  const bB = {}, aB = {};

  for (const b of book.bids) {
    const k = Math.floor(b.price/bucket)*bucket;
    bB[k] = (bB[k]||0) + b.size * b.price;
  }
  for (const a of book.asks) {
    const k = Math.floor(a.price/bucket)*bucket;
    aB[k] = (aB[k]||0) + a.size * a.price;
  }

  const topBid = Object.entries(bB).sort((a,b) => b[1]-a[1])[0];
  const topAsk = Object.entries(aB).sort((a,b) => b[1]-a[1])[0];

  const bullWall = topBid ? { price: parseFloat(topBid[0]), usd: topBid[1] } : null;
  const bearWall = topAsk ? { price: parseFloat(topAsk[0]), usd: topAsk[1] } : null;

  const totalBids = book.bids.reduce((s,b) => s + b.size*b.price, 0);
  const totalAsks = book.asks.reduce((s,a) => s + a.size*a.price, 0);
  const depthRatio = (totalBids - totalAsks) / (totalBids + totalAsks);

  let bias = depthRatio * 0.4;
  let wallSignal = 0;

  // Strong nearby wall = clear directional signal
  if (bullWall) {
    const prox = (price - bullWall.price) / price;
    if (prox < 0.003) { bias += 0.45; wallSignal = 1; }       // price sitting on support
    else if (prox < 0.008) { bias += 0.25; wallSignal = 0.5; }
  }
  if (bearWall) {
    const prox = (bearWall.price - price) / price;
    if (prox < 0.003) { bias -= 0.45; wallSignal = -1; }      // price hitting resistance
    else if (prox < 0.008) { bias -= 0.25; wallSignal = -0.5; }
  }

  const wallImbalance = bullWall && bearWall ? (bullWall.usd - bearWall.usd) / (bullWall.usd + bearWall.usd) : 0;
  bias += wallImbalance * 0.15;

  const clampedBias = Math.max(-1, Math.min(1, bias));
  const confidence = Math.min(0.90, Math.abs(clampedBias) * 1.1 + Math.abs(wallSignal) * 0.2);

  return {
    name: "WALL",
    bias: clampedBias,
    confidence,
    bullWall, bearWall, depthRatio, wallSignal,
    components: { depthRatio, wallImbalance, wallSignal },
    meta: `depth:${(depthRatio*100).toFixed(1)}% bull$${bullWall?(bullWall.usd/1e6).toFixed(1)+'M':'—'} bear$${bearWall?(bearWall.usd/1e6).toFixed(1)+'M':'—'}`,
  };
}

// ── Strategy C: ATR Breakout ──────────────────────────────────
// Best for: volatile/breakout conditions, catching big moves early
// Signal: price breaking above/below ATR band + volume surge

export function strategyBreakout(candles, ticker) {
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const atr = calcATR(candles);
  const ema21 = calcEMA(closes, 21);

  // ATR bands around EMA21
  const upperBand = ema21 + atr * 1.5;
  const lowerBand = ema21 - atr * 1.5;

  // Candle momentum: last 3 candles direction strength
  const last3 = closes.slice(-4);
  const momentum = last3.slice(1).reduce((sum, c, i) => sum + (c - last3[i]) / last3[i], 0);

  // Volume surge (last candle vs average)
  const avgVol = candles.slice(-20, -1).reduce((s,c) => s+c.volume, 0) / 19;
  const lastVol = candles[candles.length-1].volume;
  const volSurge = avgVol > 0 ? lastVol / avgVol : 1;

  // Breakout signal
  let bias = 0;
  let breakType = "none";

  if (price > upperBand) {
    // Bullish breakout above ATR band
    const strength = Math.min(1, (price - upperBand) / atr);
    bias = 0.6 + strength * 0.4;
    breakType = "up";
  } else if (price < lowerBand) {
    // Bearish breakdown below ATR band
    const strength = Math.min(1, (lowerBand - price) / atr);
    bias = -(0.6 + strength * 0.4);
    breakType = "down";
  } else {
    // Inside band — momentum only
    bias = Math.max(-0.4, Math.min(0.4, momentum * 30));
    breakType = "range";
  }

  // Volume confirmation boosts confidence
  const volBoost = Math.min(0.25, (volSurge - 1) * 0.1);
  const confidence = Math.min(0.90, Math.abs(bias) * 0.85 + volBoost);

  return {
    name: "BREAKOUT",
    bias: Math.max(-1, Math.min(1, bias)),
    confidence,
    atr, upperBand, lowerBand, ema21,
    volSurge, momentum, breakType,
    components: { momentum, volSurge, breakType },
    meta: `break:${breakType} vol:${volSurge.toFixed(1)}x atr:$${atr.toFixed(0)}`,
  };
}

// ── Auto Strategy Selector ─────────────────────────────────────
// Picks best strategy based on market conditions

export function autoSelectStrategy(stratA, stratB, stratC, ticker) {
  const volatility = Math.abs(ticker.priceChangePercent);
  const spread = ticker.ask - ticker.bid;
  const spreadPct = spread / ticker.price * 100;

  // Breakout wins in high volatility (>1.5% move in 24h)
  if (volatility > 1.5 && stratC.confidence > 0.5) return "BREAKOUT";

  // Wall wins in tight spread / low volatility (market is ranging)
  if (volatility < 0.8 && spreadPct < 0.05 && stratB.confidence > 0.45) return "WALL";

  // RSI_EMA wins by default (most consistent for trending momentum)
  return "RSI_EMA";
}

// ── Main Signal Compute ────────────────────────────────────────

export function detectWalls(book, price) {
  if (!book) return { wallBias: 0, wallStrength: 0, bullWall: null, bearWall: null };
  const result = strategyWall(book, price);
  return { wallBias: result.bias, wallStrength: result.confidence, ...result };
}

export async function computeSignals(activeStrategies = { RSI_EMA: true, WALL: true, BREAKOUT: true }, autoMode = true) {
  const [candlesR, tickerR, clR, bookR] = await Promise.allSettled([
    fetchKrakenOHLC(),
    fetchKrakenTicker(),
    fetchChainlink(),
    fetchOrderBook(150),
  ]);

  if (candlesR.status === "rejected") throw new Error("Candles: " + candlesR.reason?.message);
  if (tickerR.status === "rejected") throw new Error("Ticker: " + tickerR.reason?.message);

  const candles = candlesR.value;
  const ticker = tickerR.value;
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const atr = calcATR(candles);

  const oraclePrice = clR.status === "fulfilled" && clR.value > 1000 ? clR.value : null;
  const book = bookR.status === "fulfilled" ? bookR.value : null;

  // Run all 3 strategies
  const stratA = strategyRSI_EMA(closes, atr);
  const stratB = strategyWall(book, price);
  const stratC = strategyBreakout(candles, ticker);

  // Determine which strategy is active
  let activeStrat = "RSI_EMA";
  if (autoMode) {
    activeStrat = autoSelectStrategy(stratA, stratB, stratC, { ...ticker, price });
  } else {
    // Manual: pick highest confidence among enabled strategies
    const enabled = [
      activeStrategies.RSI_EMA ? stratA : null,
      activeStrategies.WALL    ? stratB : null,
      activeStrategies.BREAKOUT ? stratC : null,
    ].filter(Boolean);

    if (enabled.length === 0) {
      activeStrat = "RSI_EMA"; // fallback
    } else {
      activeStrat = enabled.reduce((best, s) => s.confidence > best.confidence ? s : best, enabled[0]).name;
    }
  }

  // Get the leading signal
  const stratMap = { RSI_EMA: stratA, WALL: stratB, BREAKOUT: stratC };
  const lead = stratMap[activeStrat];

  // If multiple strategies are on, blend as secondary confirmation (20% weight)
  let finalBias = lead.bias;
  let blendCount = 1;

  if (activeStrategies.RSI_EMA && activeStrat !== "RSI_EMA") {
    finalBias = finalBias * 0.8 + stratA.bias * 0.2; blendCount++;
  }
  if (activeStrategies.WALL && activeStrat !== "WALL" && stratB.confidence > 0.3) {
    finalBias = finalBias * 0.85 + stratB.bias * 0.15; blendCount++;
  }
  if (activeStrategies.BREAKOUT && activeStrat !== "BREAKOUT") {
    finalBias = finalBias * 0.8 + stratC.bias * 0.2; blendCount++;
  }

  return {
    bias: Math.max(-1, Math.min(1, finalBias)),
    confidence: lead.confidence,
    currentPrice: price,
    oraclePrice,
    stats: { ...ticker, quoteVolume: ticker.volume * price },
    atr,
    rsi: stratA.rsi,
    ema9: stratA.ema9,
    ema21: stratA.ema21,
    walls: { wallBias: stratB.bias, wallStrength: stratB.confidence, bullWall: stratB.bullWall, bearWall: stratB.bearWall, depthRatio: stratB.depthRatio },

    // Strategy details
    activeStrategy: activeStrat,
    autoMode,
    strategies: { A: stratA, B: stratB, C: stratC },
    components: lead.components,
    leadMeta: lead.meta,
  };
}
