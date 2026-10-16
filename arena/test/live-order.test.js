import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import axios from "axios";

// Throwaway signing key so requests can be built; no request leaves this process.
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
process.env.POLYMARKET_API_KEY = "00000000-0000-4000-8000-000000000000";
process.env.POLYMARKET_PRIVATE_KEY = seed.toString("base64");
const pm = await import("../../polymarket-us.js");

function fakeExchange(reply) {
  const sent = [];
  axios.defaults.adapter = async config => {
    sent.push({ method: config.method, url: config.url, body: config.data ? JSON.parse(config.data) : null });
    return { status: 200, statusText: "OK", headers: {}, config, data: reply(config) };
  };
  return sent;
}

test("buyOutcomeFOK: Down is BUY_SHORT priced on the Up side (1 - our price)", async () => {
  const sent = fakeExchange(() => ({ id: "o1", state: "ORDER_STATE_FILLED", filledQuantity: "3.7" }));
  const r = await pm.buyOutcomeFOK({ slug: "btc-15m", side: "Down", sizeUsd: 3, price: 0.80 });
  assert.equal(r.filled, true); assert.equal(r.qty, 3.7);
  const o = sent.find(x => x.method === "post").body;
  assert.equal(o.intent, "ORDER_INTENT_BUY_SHORT");
  assert.equal(o.price.value, "0.19", "we pay at most 81¢ for Down, sent as Up 19¢");
  assert.equal(o.tif, "TIME_IN_FORCE_FILL_OR_KILL");
  assert.ok(o.quantity * 0.81 <= 3 + 1e-9, "cost never above the bet");
});

test("buyOutcomeFOK: Up is BUY_LONG at our price + 1¢", async () => {
  const sent = fakeExchange(() => ({ id: "o2", state: "ORDER_STATE_FILLED", filledQuantity: "1.16" }));
  const r = await pm.buyOutcomeFOK({ slug: "btc-15m", side: "Up", sizeUsd: 1, price: 0.85 });
  assert.equal(r.filled, true);
  const post = sent.find(x => x.method === "post").body;
  assert.equal(post.intent, "ORDER_INTENT_BUY_LONG");
  assert.equal(post.price.value, "0.86");
});

test("buyOutcomeFOK: tripwire refuses anything outside $0.50-$30 without calling the exchange", async () => {
  const sent = fakeExchange(() => ({}));
  for (const sizeUsd of [0.1, 30.01, 50]) assert.equal((await pm.buyOutcomeFOK({ slug: "x", side: "Up", sizeUsd, price: 0.8 })).filled, false);
  assert.equal((await pm.buyOutcomeFOK({ slug: "x", side: "Sideways", sizeUsd: 1, price: 0.8 })).filled, false);
  assert.equal(sent.length, 0);
});

test("buyOutcomeFOK: a killed order is reported as not filled", async () => {
  fakeExchange(c => (c.method === "post" ? { id: "o3", state: "ORDER_STATE_CANCELED" } : c.url.includes("/positions") ? { positions: {} } : {}));
  const r = await pm.buyOutcomeFOK({ slug: "x", side: "Up", sizeUsd: 3, price: 0.8 });
  assert.equal(r.filled, false); assert.match(r.error, /CANCELED/);
});

test("buyOutcomeFOK: fills are read from a wrapped order or an executions list", async () => {
  fakeExchange(c => (c.method === "post" ? { id: "o4", executions: [] }
    : c.url.includes("/v1/order/") ? { order: { id: "o4", state: "ORDER_STATE_FILLED", cumQuantity: "3.7" } } : { positions: {} }));
  let r = await pm.buyOutcomeFOK({ slug: "x", side: "Down", sizeUsd: 3, price: 0.80 });
  assert.equal(r.filled, true); assert.equal(r.qty, 3.7);
  fakeExchange(c => (c.method === "post" ? { id: "o5", executions: [{ quantity: "1.2" }] } : { positions: {} }));
  r = await pm.buyOutcomeFOK({ slug: "x", side: "Down", sizeUsd: 1, price: 0.80 });
  assert.equal(r.filled, true); assert.equal(r.qty, 1.2);
});

test("buyOutcomeFOK: a Down fill that only shows as a short position is still caught", async () => {
  let calls = 0;
  fakeExchange(c => {
    if (c.method === "post") return { id: "o6", executions: [] };
    if (c.url.includes("/positions")) return calls++ === 0 ? { positions: {} } : { positions: { x: { qtyBoughtDecimal: "0", netPosition: "-1.23" } } };
    return { id: "o6" };
  });
  const r = await pm.buyOutcomeFOK({ slug: "x", side: "Down", sizeUsd: 1, price: 0.80 });
  assert.equal(r.filled, true); assert.equal(r.viaPositions, true); assert.equal(r.qty, 1.23);
});

test("real-order slip: none past the band's top unless COPY_LIVE_OVER_CAP allows it", async () => {
  const ct = await import("../copy-trader.js");
  const keep = { maxPrice: ct.CFG.maxPrice, liveSlip: ct.CFG.liveSlip, liveOverCap: ct.CFG.liveOverCap };
  try {
    Object.assign(ct.CFG, { maxPrice: 0.72, liveSlip: 0.03, liveOverCap: 0 });
    assert.equal(ct.liveSlipFor(0.72), 0); assert.equal(ct.liveSlipFor(0.70), 0.02); assert.equal(ct.liveSlipFor(0.60), 0.03);
    ct.CFG.liveOverCap = 0.02;
    assert.equal(ct.liveSlipFor(0.72), 0.02, "up to 74¢ at the top of the band"); assert.equal(ct.liveSlipFor(0.60), 0.03);
  } finally { Object.assign(ct.CFG, keep); }
});

test("owner real-money band: never pays past COPY_LIVE_MAX_PRICE, whatever the rule's band", async () => {
  const ct = await import("../copy-trader.js");
  const keep = { maxPrice: ct.CFG.maxPrice, liveSlip: ct.CFG.liveSlip, liveOverCap: ct.CFG.liveOverCap, liveEntryMs: ct.CFG.liveEntryMs, liveMinPrice: ct.CFG.liveMinPrice, liveMaxPrice: ct.CFG.liveMaxPrice };
  try {
    Object.assign(ct.CFG, { maxPrice: 0.92, liveSlip: 0.03, liveOverCap: 0.02, liveEntryMs: 240_000, liveMinPrice: 0.65, liveMaxPrice: 0.89 });
    assert.equal(ct.liveSlipFor(0.89), 0, "at the top: no slip");
    assert.equal(ct.liveSlipFor(0.87), 0.02, "up to 89¢, not the rule's 92¢");
    assert.equal(ct.liveSlipFor(0.70), 0.03);
    assert.deepEqual(ct.liveOver(), { minPrice: 0.65, maxPrice: 0.89, preferMax: 0.89, entryWindowMs: 240_000, minMsLeft: ct.CFG.minMsLeft });
  } finally { Object.assign(ct.CFG, keep); }
});

test("depth pricing: the level where the whole size fills, capped", async () => {
  const pm = await import("../../polymarket-us.js");
  const book = { marketData: { offers: [{ px: { value: "0.70" }, qty: "10" }, { px: { value: "0.72" }, qty: "10" }, { px: { value: "0.90" }, qty: "100" }],
    bids: [{ px: { value: "0.28" }, qty: "5" }, { px: { value: "0.25" }, qty: "50" }] } };
  assert.deepEqual(pm.depthPriceFrom(book, "Up", 5, 0.89), { price: 0.70, depthUsd: 7 });
  assert.deepEqual(pm.depthPriceFrom(book, "Up", 12, 0.89), { price: 0.72, depthUsd: 14.2 });
  assert.equal(pm.depthPriceFrom(book, "Up", 18, 0.89).price, null, "not enough under 89¢");
  // Down buys at 1 - bid: 72¢ for 5, then 75¢.
  assert.deepEqual(pm.depthPriceFrom(book, "Down", 18, 0.89), { price: 0.75, depthUsd: 41.1 });
  assert.equal(pm.depthPriceFrom({}, "Up", 5), null);
});
