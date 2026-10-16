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

test("a lineup runs alongside SHADOW's own rule; clearing it restores the original", () => {
  const before = ct.shadowRule();
  const r = lab.validateRule({ ...before, priceMin: 0.60, priceMax: 0.70, follow: "consensus", hoursUtc: [0, 12] }).rule;
  ct.applyLineup([{ id: "a", rule: r }, { id: "b", rule: { ...r, side: "down" } }]);
  assert.deepEqual(ct.activeLineup().map(l => l.id), ["a", "b"]);
  assert.equal(ct.activeLineup()[0].over.minPrice, 0.60); assert.equal(ct.activeLineup()[0].over.follow, "consensus");
  assert.equal(ct.CFG.liveHours, null, "each rule carries its own hours");
  ct.applyLineup([]);
  assert.equal(ct.activeLineup().length, 0);
  assert.deepEqual(ct.shadowRule(), before);
});

test("market conditions: BTC's lead over the start price and its 5-minute move", () => {
  const now = 1_000_000;
  const m = lab.marketState({ spot: 100_100, strike: 100_000, pxs: [[now - 6 * 60_000, 100_000], [now - 60_000, 100_050]] }, now);
  assert.equal(m.lead, 10); assert.equal(m.move, 10);
  assert.equal(lab.marketState({ spot: 100_000, strike: null, pxs: [] }, now).lead, null);
  const r = lab.validateRule({ ...RULE, minLeadBps: 5, moveMaxBps: 20 }).rule;
  assert.equal(lab.marketOk(r, "Up", 10, 10), true);
  assert.equal(lab.marketOk(r, "Down", 10, 10), false, "Down is 10 bps behind");
  assert.equal(lab.marketOk(r, "Up", 10, 30), false, "too busy");
  assert.equal(lab.marketOk(r, "Up", null, 10), false, "no data fails a set condition");
  assert.equal(lab.ruleEntry(r, snap({ lead: 12, move: 8 }), BASE).side, "Up");
  assert.equal(lab.ruleEntry(r, snap({ lead: -12, move: 8 }), BASE), null);
  assert.match(lab.describeRule(r), /bps vs the start price/);
  assert.equal(lab.validateRule({ minLeadBps: 50, maxLeadBps: 10 }).ok, false);
});

test("auto mode: adds proven rules, swaps in a better one, drops a loser, one change per 3h", async () => {
  lab._reset();
  const t0 = BASE;
  const good = (i, w) => win(i, w, [snap()]);
  await lab.addProposal({ name: "a", rule: RULE }, t0);
  await lab.addProposal({ name: "b", rule: { ...RULE, priceMax: 0.70 } }, t0);
  for (let i = 1; i <= 25; i++) lab._push(good(i, i % 4 ? 1 : 0));          // both win 75% at 64¢
  let r = await lab.autoManage(t0 + 30 * 900_000);
  assert.equal(r.changed, true); assert.equal(lab.lineup().length, 1);
  assert.equal((await lab.autoManage(t0 + 31 * 900_000)).changed, false, "cooldown");
  r = await lab.autoManage(t0 + 31 * 900_000 + 3 * 3600_000);
  assert.equal(r.changed, true); assert.equal(lab.lineup().length, 2, "room for a second winner");
  // Everything turns into a loser: the first member is dropped once it has 30 losing bets since joining.
  for (let i = 60; i <= 100; i++) lab._push(good(i, 0));
  r = await lab.autoManage(t0 + 200 * 900_000);
  assert.match(r.msg, /dropped/); assert.equal(lab.lineup().length, 1);
  assert.ok(lab.labStatus(RULE).autoLog.length >= 3);
});

test("lineup by hand: full lineup replaces its weakest member", async () => {
  lab._reset();
  const t0 = BASE;
  for (const n of ["p1", "p2", "p3", "p4"]) await lab.addProposal({ name: n, rule: { ...RULE, priceMax: 0.66 + ["p1", "p2", "p3", "p4"].indexOf(n) * 0.02 } }, t0);
  for (let i = 1; i <= 25; i++) lab._push(win(i, i % 4 ? 1 : 0, [snap()]));
  for (const n of ["p1", "p2", "p3"]) assert.equal((await lab.applyProposal(n, t0 + 26 * 900_000)).ok, true);
  const r = await lab.applyProposal("p4", t0 + 26 * 900_000);
  assert.equal(r.ok, true); assert.ok(r.dropped); assert.equal(lab.lineup().length, lab.LINEUP_MAX);
  assert.equal((await lab.removeFromLineup("p4")).ok, true);
  assert.equal((await lab.applyProposal("nope")).ok, false);
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
  // Windows after "now", so they count as forward bets whatever day the tests run.
  const T = Date.now() + 60_000, later = (i, outcome) => ({ slug: `f${i}`, start: T + i * 900_000, end: T + (i + 1) * 900_000, outcome, snaps: [snap()] });
  const reply = props => async (url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ proposals: props }) }] }) }; };
  try {
    // SEARCH: no champion yet, two distinct ideas.
    globalThis.fetch = reply([{ name: "early-entry", rule: { ...RULE, maxLeftSec: 360 }, rationale: "test" }, { name: "crowd-only", rule: { ...RULE, follow: "consensus" } }]);
    const made = await agents.tune(log, lab);
    assert.deepEqual(made.map(p => p.id), ["early-entry", "crowd-only"]); assert.equal(made[0].author, "TUNER"); assert.equal(made[0].parent, null);
    assert.match(sent.system, /MODE: SEARCH/); assert.match(sent.messages[0].content, /Sensitivity/);
    assert.match(lines.at(-1), /new SHADOW proposal crowd-only/);
    // early-entry wins 20+ forward bets: it becomes the champion and the TUNER refines it.
    for (let i = 1; i <= 30; i++) lab._push(later(i, i % 4 ? 1 : 0));
    const champ = lab.champion()?.id;
    assert.ok(["early-entry", "crowd-only"].includes(champ), "a proposal with 20+ profitable forward bets is the champion");
    globalThis.fetch = reply([{ name: "champ-tighter", rule: { ...RULE, minShare: 0.95 } }]);
    const ref = await agents.tune(log, lab);
    assert.match(sent.system, /MODE: REFINE/); assert.match(sent.system, new RegExp(champ));
    assert.equal(ref[0].parent, champ);
    assert.match(lines.at(-1), new RegExp(`refining ${champ}`));
    assert.equal(lab.labStatus(RULE).mode, "refine");
    // The refinement is judged against the champion on the same windows.
    for (let i = 31; i <= 55; i++) lab._push(later(i, 1));
    const vs = lab.scoreProposal(ref[0]).vsParent;
    assert.equal(vs.parent, champ); assert.equal(vs.n, vs.parentN, "same windows for both");
  } finally { globalThis.fetch = realFetch; if (realKey == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey; }
});

test("signal log keeps a window whose result arrives after the next window has started", async () => {
  lab._reset();
  const E1 = 900_000, E2 = 1_800_000, c = { side: "Up", share: 1, agree: 3, against: 0 };
  lab.observe({ slug: "w1", start: 0, end: E1, now: E1 - 200_000, up: 0.6, down: 0.42, consensus: c });
  lab.observe({ slug: "w2", start: E1, end: E2, now: E2 - 590_000, up: 0.5, down: 0.52, consensus: c });   // next window starts recording
  await lab.settle({ slug: "w1", outcome: 1 });                                                             // w1's result, 5 min late
  assert.equal(lab.labWindows().length, 1); assert.equal(lab.labWindows()[0].slug, "w1"); assert.equal(lab.labWindows()[0].outcome, 1);
  await lab.settle({ slug: "w2", outcome: 0 });
  assert.equal(lab.labWindows().length, 2, "the current window settles too");
});

test("PRISM retires early losers and rules that hardly fire; a full lab replaces its weakest", async () => {
  const t0 = BASE - 30 * H;
  lab._reset();
  await lab.addProposal({ name: "early-loser", rule: RULE }, t0);
  await lab.addProposal({ name: "never-fires", rule: { ...RULE, minAgree: 9 } }, t0);
  for (let i = 1; i <= 16; i++) lab._push(win(i, i % 4 ? 0 : 1, [snap()]));   // 25% wins at 64¢
  assert.equal(await lab.pruneProposals(() => {}, BASE), 2);
  const st = Object.fromEntries(lab.labStatus(RULE).proposals.map(p => [p.id, p.retiredWhy || p.status]));
  assert.match(st["early-loser"], /losing early: 16 forward bets/);
  assert.match(st["never-fires"], /too rare: 0 forward bets/);

  lab._reset();
  for (let k = 0; k < 16; k++) assert.equal((await lab.addProposal({ name: `p${k}`, rule: { ...RULE, priceMax: 0.60 + k * 0.01 } }, t0 + k * H)).ok, true);
  assert.equal(lab.roomForProposal(t0 + 16 * H + 1), true);
  const fresh = await lab.addProposal({ name: "too-soon", rule: { ...RULE, minAgree: 3 } }, t0 + 16 * H + 1);
  assert.equal(fresh.ok, true, "the oldest ones are 6h+ old, so one is replaced");
  const retired = lab.labStatus(RULE).proposals.filter(p => p.status === "retired");
  assert.equal(retired.length, 1); assert.match(retired[0].retiredWhy, /replaced by too-soon/);
});

test("a full lab of fresh proposals has no room, so TUNER skips its model call", async () => {
  const t0 = BASE;
  lab._reset();
  for (let k = 0; k < 16; k++) await lab.addProposal({ name: `f${k}`, rule: { ...RULE, priceMax: 0.60 + k * 0.01 } }, t0);
  assert.equal(lab.roomForProposal(t0 + H), false);
  assert.equal(lab.roomForProposal(t0 + 7 * H), true, "6h on, the weakest can be replaced");
});
