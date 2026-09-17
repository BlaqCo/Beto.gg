/**
 * ws-feed.js — real-time price feed: positions (proven) + discovery (new)
 *
 * ORIGINAL PURPOSE (WS_FEED=true, unchanged): stream prices for OPEN
 * POSITIONS so exits fire near-instantly instead of on a 15-20s REST poll.
 *
 * NEW, EXPERIMENTAL PURPOSE (WS_DISCOVERY=true): REST is now hard-capped at
 * 15 BBO checks/scan against 429s — with 75+ markets sitting in-band every
 * scan, that's under 20% real coverage. The docs describe each WS
 * connection streaming up to 10 instruments with no rate limit. What is
 * genuinely NOT confirmed is whether Polymarket allows MULTIPLE CONCURRENT
 * connections from one account — that is exactly what this build tests.
 * It opens a small, conservative POOL of connections (WS_POOL_SIZE, default
 * 3 = 30 slugs) rather than guessing at a large number, and logs every
 * connection's real fate so the actual ceiling shows up in the next log
 * the same way the REST ceiling did — measured, not assumed.
 *
 * Isolation, in both modes: never places orders, and the bot uses a
 * streamed price only when fresh — REST remains the tested fallback for
 * everything not covered, and if EVERY WS connection fails, the bot runs
 * exactly as it did before this file existed.
 */

const GATEWAY_WS = (process.env.POLYMARKET_WS_URL || "wss://gateway.polymarket.us/v1/ws/markets");
const ENABLED           = process.env.WS_FEED === "true";
const DISCOVERY_ENABLED = process.env.WS_DISCOVERY === "true";
const MAX_SUBS   = 10;          // documented per-connection limit
const FRESH_MS   = 8_000;       // a streamed price older than this isn't trusted
// Conservative on purpose — same lesson as the REST rate limit: start low,
// raise it later WITH evidence, not a guess. 3 connections is exactly the
// kind of number that should be interrogated by real logs, not assumed safe.
const POOL_SIZE  = Math.max(1, parseInt(process.env.WS_POOL_SIZE || "3", 10));

const prices = new Map();       // slug → { bid, ask, ts } — shared across the whole pool
let shapeLogged = false;

// Connection 0 is reserved for held POSITIONS (setWatchlist) — the proven,
// original use of this file, and the one that matters most if anything has
// to be sacrificed. Connections 1..N are for DISCOVERY (setDiscoveryWatchlist).
// Each is a fully independent socket with its own reconnect/backoff state.
function newConn(label) {
  return { label, ws: null, subscribed: new Set(), connected: false, retry: 0, reconnectTimer: null };
}
const pool = [newConn("positions")];

export function wsEnabled() { return ENABLED; }
export function wsDiscoveryEnabled() { return DISCOVERY_ENABLED; }
export function wsStatus() {
  return {
    enabled: ENABLED, discoveryEnabled: DISCOVERY_ENABLED, cached: prices.size,
    connections: pool.map(c => ({ label: c.label, connected: c.connected, subscribed: [...c.subscribed] })),
  };
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

function send(conn, obj) { try { conn.ws?.send(JSON.stringify(obj)); } catch {} }

function applyWatchlist(conn, wantSlugs) {
  const want = new Set(wantSlugs.filter(Boolean).slice(0, MAX_SUBS));
  const add = [...want].filter(s => !conn.subscribed.has(s));
  const drop = [...conn.subscribed].filter(s => !want.has(s));
  conn.subscribed = want;
  if (!conn.connected) return;
  if (drop.length) { send(conn, { action: "unsubscribe", markets: drop, marketSlugs: drop }); drop.forEach(s => prices.delete(s)); }
  if (add.length)  { send(conn, { action: "subscribe",   markets: add,  marketSlugs: add }); }
  if (add.length || drop.length)
    console.log(`📡 WS [${conn.label}] watching ${conn.subscribed.size}: +${add.length} −${drop.length}`);
}

/** Keep connection 0 pointed at the markets we currently hold. Unchanged
 * behaviour from before this file supported a pool. */
export function setWatchlist(slugs = []) {
  if (!ENABLED) return;
  applyWatchlist(pool[0], slugs);
}

/** NEW: spread a prioritized candidate list across the discovery portion of
 * the pool (connections 1..N), up to POOL_SIZE-1 connections × 10 slugs
 * each. Markets beyond that capacity simply aren't covered by WS this
 * cycle — REST remains the fallback for whatever doesn't fit. */
export function setDiscoveryWatchlist(slugs = []) {
  if (!DISCOVERY_ENABLED) return;
  const discoveryConns = pool.slice(1);
  const clean = slugs.filter(Boolean);
  discoveryConns.forEach((conn, i) => {
    applyWatchlist(conn, clean.slice(i * MAX_SUBS, (i + 1) * MAX_SUBS));
  });
}

function connect(conn) {
  if (conn.ws) return;
  if (typeof WebSocket === "undefined") {
    console.log("📡 WS feed unavailable — this Node build has no WebSocket; staying on REST");
    return;
  }
  try {
    conn.ws = new WebSocket(GATEWAY_WS);
    conn.ws.onopen = () => {
      conn.connected = true; conn.retry = 0;
      console.log(`📡 WS [${conn.label}] connected → ${GATEWAY_WS}`);
      if (conn.subscribed.size) send(conn, { action: "subscribe", markets: [...conn.subscribed], marketSlugs: [...conn.subscribed] });
    };
    conn.ws.onmessage = e => parseMessage(e.data);
    conn.ws.onerror = () => {};
    conn.ws.onclose = () => {
      conn.connected = false; conn.ws = null;
      const wait = Math.min(60_000, 2_000 * Math.pow(2, conn.retry++));
      if (conn.retry <= 8) {
        console.log(`📡 WS [${conn.label}] closed — reconnecting in ${Math.round(wait / 1000)}s`);
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = setTimeout(() => connect(conn), wait);
      } else {
        console.log(`📡 WS [${conn.label}] gave up after repeated failures — that slice falls back to REST`);
      }
    };
  } catch (err) {
    conn.ws = null;
    console.log(`📡 WS [${conn.label}] connect failed (${err.message}) — that slice falls back to REST`);
  }
}

export function startWsFeed() {
  if (!ENABLED && !DISCOVERY_ENABLED) {
    console.log("📡 WS feed OFF (set WS_FEED=true for exits, WS_DISCOVERY=true for scan coverage)");
    return null;
  }
  if (ENABLED) connect(pool[0]);
  if (DISCOVERY_ENABLED) {
    // This is the actual experiment: try POOL_SIZE-1 additional connections
    // and let the logs show how many Polymarket genuinely allows. If the
    // real ceiling turns out to be 1 connection total, this degrades to
    // "no discovery coverage, REST unchanged" — not a crash, not a regression.
    console.log(`📡 WS discovery: attempting ${POOL_SIZE - 1} additional connection(s) — the real per-account ceiling is unconfirmed, this is what tests it`);
    for (let i = 1; i < POOL_SIZE; i++) {
      const conn = newConn(`discovery-${i}`);
      pool.push(conn);
      connect(conn);
    }
  }
  return pool;
}
