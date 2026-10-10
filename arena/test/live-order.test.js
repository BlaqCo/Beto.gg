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
  const o = sent[0].body;
  assert.equal(o.intent, "ORDER_INTENT_BUY_SHORT");
  assert.equal(o.price.value, "0.19", "we pay at most 81¢ for Down, sent as Up 19¢");
  assert.equal(o.tif, "TIME_IN_FORCE_FILL_OR_KILL");
  assert.ok(o.quantity * 0.81 <= 3 + 1e-9, "cost never above the bet");
});

test("buyOutcomeFOK: Up is BUY_LONG at our price + 1¢", async () => {
  const sent = fakeExchange(() => ({ id: "o2", state: "ORDER_STATE_FILLED", filledQuantity: "1.16" }));
  const r = await pm.buyOutcomeFOK({ slug: "btc-15m", side: "Up", sizeUsd: 1, price: 0.85 });
  assert.equal(r.filled, true);
  assert.equal(sent[0].body.intent, "ORDER_INTENT_BUY_LONG");
  assert.equal(sent[0].body.price.value, "0.86");
});

test("buyOutcomeFOK: tripwire refuses anything outside $0.50-$5 without calling the exchange", async () => {
  const sent = fakeExchange(() => ({}));
  for (const sizeUsd of [0.1, 5.01, 50]) assert.equal((await pm.buyOutcomeFOK({ slug: "x", side: "Up", sizeUsd, price: 0.8 })).filled, false);
  assert.equal((await pm.buyOutcomeFOK({ slug: "x", side: "Sideways", sizeUsd: 1, price: 0.8 })).filled, false);
  assert.equal(sent.length, 0);
});

test("buyOutcomeFOK: a killed order is reported as not filled", async () => {
  fakeExchange(c => (c.method === "post" ? { id: "o3", state: "ORDER_STATE_CANCELED" } : { positions: {} }));
  const r = await pm.buyOutcomeFOK({ slug: "x", side: "Up", sizeUsd: 3, price: 0.8 });
  assert.equal(r.filled, false); assert.match(r.error, /CANCELED/);
});
