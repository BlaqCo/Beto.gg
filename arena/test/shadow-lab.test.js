import { test } from "node:test";
import assert from "node:assert/strict";
import * as lab from "../shadow-lab.js";
import * as ct from "../copy-trader.js";
import * as agents from "../agents.js";

const H = 3600_000, BASE = Date.UTC(2026, 9, 14, 2, 0);   // 02:00 UTC
const snap = (o = {}) => ({ left: 200, up: 0.64, down: 0.38, cSide: "Up", share: 1, agree: 4, against: 0, pSide: null, ...o });
const win = (i, outcome, snaps, hour = 2) => ({ slug: `w${i}`, start: BASE + (hour - 2) * H + i * 900_000, end: BASE + (hour - 2) * H + (i + 1) * 900_000, outcome, snaps });
const RULE = lab.validateRule({ priceMin: 0.56, priceMax: 0.72, minLeftSec: 30, maxLeftSec: 270, minShare: 0.85, minAgree: 2, follow: "either" }).rule;

test("rule validation clamps agents to safe ranges", () => {
  assert.equal(lab.validateRule({ priceMin: 0.1 }).ok, false);
  assert.equal(lab.validateRule({ priceMin: 0.7, priceMax: 0.6 }).ok, false);
  assert.equal(lab.validateRule({ follow: "random" }).ok, false);
  assert.equal(lab.validateRule({ hoursUtc: [3, 3] }).ok, false);
  const v = lab.validateRule({});
  assert.equal(v.ok, true); assert.equal(v.rule.follow, "either"); assert.equal(v.rule.hoursUtc, null);
});

test("rule entry: time, price, share, agreement, follow modes, side, hours", () => {
  assert.deepEqual(lab.ruleEntry(RULE, snap(), BASE), { side: "Up", px: 0.64 });
  assert.equal(lab.ruleEntry(RULE, snap({ left: 400 }), BASE), null, "too early");
  assert.equal(lab.ruleEntry(RULE, snap({ up: 0.80 }), BASE), null, "over the band");
  assert.equal(lab.ruleEntry(RULE, snap({ share: 0.7 }), BASE), null, "split");
  assert.equal(lab.ruleEntry(RULE, snap({ agree: 1 }), BASE), null, "1 wallet");
  // Primary on Down with no smart money: either follows it, consensus doesn't.
  const p = snap({ cSide: null, share: 0, agree: 0, pSide: "Down", down: 0.60 });
  assert.deepEqual(lab.ruleEntry(RULE, p, BASE), { side: "Down", px: 0.60 });
  assert.equal(lab.ruleEntry({ ...RULE, follow: "consensus" }, p, BASE), null);
  // Primary against a strong vote: the share flips, so it's a split.
  assert.equal(lab.ruleEntry(RULE, snap({ pSide: "Down", down: 0.60 }), BASE), null);
  assert.equal(lab.ruleEntry({ ...RULE, follow: "both" }, snap({ pSide: "Up" }), BASE).side, "Up");
  assert.equal(lab.ruleEntry({ ...RULE, follow: "both" }, snap(), BASE), null, "both needs the primary");
  assert.equal(lab.ruleEntry({ ...RULE, side: "down" }, snap(), BASE), null);
  assert.equal(lab.ruleEntry({ ...RULE, maxAgainst: 0 }, snap({ share: 0.9, against: 1 }), BASE), null);
  assert.equal(lab.ruleEntry({ ...RULE, hoursUtc: [12, 24] }, snap(), BASE), null, "02 UTC is outside 12-24");
});

test("backtest: first qualifying snapshot, fees, results, forward window", () => {
  const ws = [
    win(0, 1, [snap({ left: 400 }), snap({ left: 240, up: 0.60 }), snap({ left: 200, up: 0.70 })]),   // enters at 60¢, Up wins
    win(1, 0, [snap({ left: 240, up: 0.65 })]),                                                     // enters 65¢, loses
    win(2, null, [snap()]),                                                                         // no result: skipped
    win(3, 1, [snap({ share: 0.5 })]),                                                              // no entry
  ];
  const b = lab.backtest(RULE, ws);
  assert.equal(b.n, 2); assert.equal(b.wins, 1); assert.equal(b.bets[0].px, 0.60);
  assert.ok(Math.abs(b.bets[0].pnl - (10 / 0.6 - 10 - 0.06 * (10 / 0.6) * 0.6 * 0.4)) < 1e-3, "won: shares − stake − taker fee");
  assert.ok(b.bets[1].pnl < -10, "lost the stake plus the fee");
  assert.equal(lab.backtest(RULE, ws, { since: ws[1].start }).n, 1, "forward = windows after the proposal");
});

test("proposals: forward bets gate Apply; PRISM retires forward losers", async () => {
  lab._reset();
  const t0 = BASE;
  const r = await lab.addProposal({ name: "Tight Band", rule: { ...RULE, priceMax: 0.68 }, author: "TUNER" }, t0);
  assert.equal(r.ok, true); assert.equal(r.proposal.id, "tight-band");
  assert.equal((await lab.addProposal({ name: "dup", rule: { ...RULE, priceMax: 0.68 } }, t0)).ok, false, "same rule twice");
  assert.equal((await lab.applyProposal("tight-band")).ok, false, "no forward bets yet");
  for (let i = 1; i <= 25; i++) lab._push(win(i, i % 4 ? 1 : 0, [snap()]));   // 75% wins at 64¢: profitable
  const s = lab.scoreProposal(lab.labStatus(RULE).proposals[0]);
  assert.equal(s.forward.n, 25); assert.ok(s.forward.perBet > 0); assert.equal(s.canApply, true);
  const a = await lab.applyProposal("tight-band");
  assert.equal(a.ok, true); assert.equal(lab.appliedRule().id, "tight-band");
  // A loser with 40+ forward bets gets retired.
  lab._reset();
  await lab.addProposal({ name: "loser", rule: RULE }, t0);
  for (let i = 1; i <= 45; i++) lab._push(win(i, i % 5 ? 0 : 1, [snap()]));   // 20% wins at 64¢
  assert.equal(await lab.pruneProposals(), 1);
  assert.equal(lab.labStatus(RULE).proposals[0].status, "retired");
});

test("sensitivity table covers every setting", () => {
  const ws = Array.from({ length: 10 }, (_, i) => win(i, 1, [snap()]));
  const t = lab.sensitivity(RULE, ws);
  for (const k of ["priceMin", "priceMax", "maxLeftSec", "minLeftSec", "minShare", "minAgree", "follow", "side", "hoursUtc"]) assert.ok(t[k].length > 0, k);
});

test("SHADOW follows the lab's rule options", () => {
  const now = 0, us = { end: 200_000, bid: 0.36, ask: 0.64, pxs: [] }, ok = { ok: true };
  const cfg = { ...ct.CFG, minPrice: 0.56, maxPrice: 0.72, preferMax: 0.72, entryWindowMs: 270_000, minShare: 0.85, minAgree: 2 };
  const v = { Up: new Map(), Down: new Map() };
  for (let i = 0; i < 4; i++) ct.addVote(v, { wallet: "u" + i, outcome: "Up", usd: 10, price: 0.6 }, 0.3);
  assert.equal(ct.decideSmart({ votes: v, us, holding: false, now, cfg, safety: ok }).enter, true);
  assert.equal(ct.decideSmart({ votes: v, us, holding: false, now, cfg: { ...cfg, sideOnly: "down" }, safety: ok }).code, "side");
  assert.equal(ct.decideSmart({ votes: v, us, holding: false, now, cfg: { ...cfg, follow: "primary" }, safety: ok }).code, "no-primary");
  const pd = { Up: 0, Down: 100 };
  assert.equal(ct.decideSmart({ votes: v, us, holding: false, now, cfg: { ...cfg, follow: "both" }, safety: ok, primary: pd }).code, "disagree");
  assert.equal(ct.decideSmart({ votes: v, us, holding: false, now, cfg: { ...cfg, follow: "consensus" }, safety: ok, primary: pd }).side, "Up", "consensus ignores the primary");
  // The rule SHADOW reports round-trips through the lab's validator.
  assert.equal(lab.validateRule(ct.shadowRule()).ok, true);
});

test("applying a lab rule changes SHADOW, reverting restores it", () => {
  const before = ct.shadowRule();
  const r = lab.validateRule({ ...before, priceMin: 0.60, priceMax: 0.70, follow: "consensus", hoursUtc: [0, 12] }).rule;
  ct.applyLabRule(r);
  assert.equal(ct.CFG.minPrice, 0.60); assert.equal(ct.CFG.preferMax, 0.70); assert.equal(ct.CFG.follow, "consensus"); assert.deepEqual(ct.CFG.liveHours, [0, 12]);
  ct.applyLabRule(null);
  assert.deepEqual(ct.shadowRule(), before);
});

test("TUNER: waits for data, then turns a model reply into a backtested proposal", async () => {
  lab._reset();
  const lines = [];
  const log = (who, m) => lines.push(`${who}: ${m}`);
  agents._setShadowRule(() => RULE);
  assert.equal(await agents.tune(log, lab), null);
  assert.match(lines.at(-1), /waiting for data/);
  for (let i = 0; i < 60; i++) lab._push(win(i, i % 3 ? 1 : 0, [snap()]));
  const realFetch = globalThis.fetch, realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test";
  let sent = null;
  globalThis.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ name: "early-entry", rule: { ...RULE, maxLeftSec: 360 }, rationale: "test" }) }] }) }; };
  try {
    const p = await agents.tune(log, lab);
    assert.equal(p.id, "early-entry"); assert.equal(p.author, "TUNER");
    assert.match(sent.messages[0].content, /Sensitivity/);
    assert.match(lines.at(-1), /new SHADOW proposal early-entry/);
  } finally { globalThis.fetch = realFetch; if (realKey == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey; }
});
