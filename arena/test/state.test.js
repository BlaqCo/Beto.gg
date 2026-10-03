import { test } from "node:test";
import assert from "node:assert/strict";

test("BTC recorder: snapshot then restore keeps live windows and queues ended ones for settlement", async () => {
  const r = await import("../recorder.js");
  const now = 1_000_000_000;
  const saved = { live: [
      { v: 1, family: "btc15", slug: "still-open", start: now - 60_000, end: now + 600_000, ticks: [[now - 5000, .5, .52, null, 1, "L"]] },
      { v: 1, family: "btc15", slug: "ended-while-down", start: now - 900_000, end: now - 10_000, ticks: [[now - 20_000, .5, .52, null, 1, "L"]] } ],
    pending: [{ rec: { v: 1, family: "btc60", slug: "awaiting", start: 0, end: now - 100_000, ticks: [] }, since: now - 100_000 }] };
  const out = r.restoreState(saved, now);
  assert.deepEqual(out, { restoredLive: 1, restoredPending: 2 });
  const snap = r.snapshotState();
  assert.deepEqual(snap.live.map(w => w.slug), ["still-open"]);
  assert.deepEqual(snap.pending.map(p => p.rec.slug).sort(), ["awaiting", "ended-while-down"]);
  assert.equal(snap.live[0].ticks.length, 1);
  assert.deepEqual(r.restoreState(saved, now), { restoredLive: 0, restoredPending: 0 }, "no duplicates on a second restore");
});

test("sports recorder: rebuilds games and their price history from the saved log", async () => {
  const s = await import("../sports-recorder.js");
  const now = 2_000_000_000;
  const meta = { live: [{ slug: "game-a", league: "MLB", question: "A vs B", start: now - 3_600_000, end: now + 3_600_000 },
                        { slug: "game-b", league: "NBA", question: "C vs D", start: now - 7_200_000, end: now - 60_000 }],
                 pending: [{ slug: "game-c", start: now - 9e6, end: now - 3e6, since: now - 3e6 }] };
  const lines = [
    { t: now - 3_000_000, p: { "game-a": 0.61, "game-b": 0.4, "game-c": 0.7 } },
    { t: now - 120_000,   p: { "game-a": 0.63, "game-b": 0.42, "stranger": 0.5 } },
    { t: now - 30_000,    p: { "game-b": 0.45 } } ];                 // after game-b started: ignored
  const r = s.rebuildFromSaved(meta, lines, now);
  assert.deepEqual(r, { restoredLive: 1, restoredPending: 2 });
});
