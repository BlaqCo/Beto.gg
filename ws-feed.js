/**
 * ws-feed.js — real-time price feed for open positions (optional, isolated)
 *
 * Why this exists: polymarket.us REST is capped at ~60 requests/minute, which
 * is why the bot polls every 15-20s. The docs describe a WebSocket endpoint
 * (/v1/ws/markets) that streams up to 10 instruments with no rate limit.
 *
 * That gap matters most for EXITS. With a 29¢ stop loss and a 95¢ take
 * profit, a 20-second polling delay means fast markets blow straight through
 * the level before the bot sees it. Streaming the handful of markets we
 * actually hold makes those exits fire near-instantly.
 *
 * Safety: entirely optional (WS_FEED=true), never places orders, and the bot
 * falls back to REST whenever a streamed price is missing or stale. If the
 * socket dies, everything keeps working exactly as before.
 */

const GATEWAY_WS = (process.env.POLYMARKET_WS_URL || "wss://gateway.polymarket.us/v1/ws/markets");
const ENABLED    = process.env.WS_FEED === "true";
const MAX_SUBS   = 10;          // documented per-connection limit
const FRESH_MS   = 8_000;       // a streamed price older than this isn't trusted

const prices = new Map();       // slug → { bid, ask, ts }
let ws = null, subscribed = new Set(), connected = false;
let shapeLogged = false, retry = 0, reconnectTimer = null;

export function wsEnabled() { return ENABLED; }
export function wsStatus() {
  return { enabled: ENABLED, connected, subscribed: [...subscribed], cached: prices.size };
}

/** Streamed price for a slug, or null if absent/stale. */
export function livePrice(slug) {
  const p = prices.get(slug);
  if (!p || Date.now() - p.ts > FRESH_MS) return null;
  return { bid: p.bid, ask: p.ask, ageMs: Date.now() - p.ts };
}

function parseMessage(raw) {
  let msg;
  try { msg = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
  if (!shapeLogged) {
    shapeLogged = true;
    console.log(`📡 WS first message shape: ${JSON.stringify(msg).slice(0, 300)}`);
  }
  // Tolerate several plausible shapes rather than assuming one.
  const items = Array.isArray(msg) ? msg
              : msg?.data ? (Array.isArray(msg.data) ? msg.data : [msg.data])
              : [msg];
  for (const it of items) {
    const slug = it?.marketSlug || it?.slug || it?.market || it?.instrument;
    if (!slug) continue;
    const d = it.marketData || it;
    const num = v => { const n = parseFloat(v?.value ?? v); return Number.isFinite(n) ? n : null; };
    const bid = num(d.bestBid ?? d.bid ?? d.bidPx);
    const ask = num(d.bestAsk ?? d.ask ?? d.askPx);
    if (bid == null && ask == null) continue;
    const prev = prices.get(slug) || {};
    prices.set(slug, { bid: bid ?? prev.bid, ask: ask ?? prev.ask, ts: Date.now() });
  }
}

function send(obj) { try { ws?.send(JSON.stringify(obj)); } catch {} }

/** Keep the stream pointed at the markets we currently hold. */
export function setWatchlist(slugs = []) {
  if (!ENABLED) return;
  const want = new Set(slugs.filter(Boolean).slice(0, MAX_SUBS));
  const add = [...want].filter(s => !subscribed.has(s));
  const drop = [...subscribed].filter(s => !want.has(s));
  subscribed = want;
  if (!connected) return;
  if (drop.length) { send({ action: "unsubscribe", markets: drop, marketSlugs: drop }); drop.forEach(s => prices.delete(s)); }
  if (add.length)  { send({ action: "subscribe",   markets: add,  marketSlugs: add }); }
  if (add.length || drop.length)
    console.log(`📡 WS watching ${subscribed.size}: +${add.length} −${drop.length}`);
}

function connect() {
  if (!ENABLED || ws) return;
  if (typeof WebSocket === "undefined") {
    console.log("📡 WS feed unavailable — this Node build has no WebSocket; staying on REST");
    return;
  }
  try {
    ws = new WebSocket(GATEWAY_WS);
    ws.onopen = () => {
      connected = true; retry = 0;
      console.log(`📡 WS connected → ${GATEWAY_WS}`);
      if (subscribed.size) send({ action: "subscribe", markets: [...subscribed], marketSlugs: [...subscribed] });
    };
    ws.onmessage = e => parseMessage(e.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      connected = false; ws = null;
      const wait = Math.min(60_000, 2_000 * Math.pow(2, retry++));
      if (retry <= 8) {
        console.log(`📡 WS closed — reconnecting in ${Math.round(wait / 1000)}s`);
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, wait);
      } else {
        console.log("📡 WS gave up after repeated failures — REST polling continues normally");
      }
    };
  } catch (err) {
    ws = null;
    console.log(`📡 WS connect failed (${err.message}) — REST polling continues`);
  }
}

export function startWsFeed() {
  if (!ENABLED) { console.log("📡 WS feed OFF (set WS_FEED=true for real-time exit prices)"); return; }
  connect();
}