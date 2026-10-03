# Strategy arena

Tests BTC 15-minute and hourly Up/Down strategies against recorded market
prices, after spread and fees, and ranks them. **Nothing here places orders.**

## How it works

1. **Recorder** (`recorder.js`, on when `ARENA_RECORD=true`). Every 5 seconds it
   saves the YES best bid/ask for the live BTC15 and BTC60 windows, plus BTC
   spot from Coinbase. When a window settles, the whole window is saved to
   Redis (`arena:tape:btc15`, `arena:tape:btc60`), about 31 days kept.
2. **Simulator** (`sim.js`). Replays each window through each strategy:
   - a decision fills on the **next** tick (no look-ahead, some latency)
   - buys pay the **ask**, sells get the **bid**, every fill pays the taker fee
   - $10 per trade (`ARENA_STAKE`), one entry per window
3. **Leaderboard**: `GET /api/arena/leaderboard`, or `npm run arena` locally.
   `GET /api/arena/tape?family=btc15&limit=500` downloads recorded windows,
   which you can replay with `node arena/run.js --file btc15-tape.jsonl`.

## Verdicts

| Verdict | Meaning |
|---|---|
| too early | fewer than 30 trades |
| losing | even the optimistic 95% estimate loses money per trade |
| unproven | the range still includes losing |
| promising | profitable on the tape so far, not enough forward trades |
| ready for review | ≥200 **forward** trades, profitable with 95% confidence, both halves of the sample positive, beats the baseline |
| control | a deliberately dumb strategy; it should lose about spread + fees |

**Forward** trades are those in windows that started after the strategy's
`created` date — data its author could not have seen. Only forward results
count toward promotion. "Ready for review" means a human looks at it; the
arena never turns on real money.

## Adding a strategy

Drop a file in `arena/strategies/`:

```js
export default {
  name: "my-idea",            // unique, kebab-case
  author: "your-name",
  created: "2026-10-03",      // the day you add it; never backdate
  family: "btc15",            // "btc15" | "btc60" | "both"
  description: "One line: what it does.",
  decide(ctx) {
    // ctx.msLeft, ctx.msIn, ctx.windowMs   time in the window
    // ctx.up / ctx.down = { bid, ask }       prices to trade at
    // ctx.mid                                YES mid
    // ctx.spot, ctx.strike                   BTC spot vs priceToBeat (may be null)
    // ctx.history                            quotes so far in this window
    // ctx.position                           null or { side, entry, contracts, t }
    // ctx.state                              scratch object for this window
    return null;                // or { buy: "Up" | "Down" } or { sell: true, reason: "..." }
  },
};
```

Rules for every author, human or agent:

- Use only what `ctx` gives you. No network calls, no clocks, no randomness
  other than `hash01` from `lib.js`.
- Set `created` to the day you add it. Changing a strategy's logic means a
  new file with a new name and date.
- Don't edit `sim.js`, `fees.js`, the baselines or the controls in the same
  change as a new strategy.
- Every strategy you add makes it more likely that one wins by luck. Prefer
  one well-reasoned idea over ten parameter tweaks.

## Tests

`npm test` checks the fill model, fees, settlement, look-ahead and that the
coin-flip control loses money on synthetic fair markets.

## Reality check (`reality.js`)

Before trusting any arena result with real money, check that the arena's fill
model matches what actually happens. Every BTC15/BTC60 trade the bots record
(paper or real) whose window is on the tape is replayed through the arena: same
window, same side, entering and selling when the bot did. The bot's P&L and the
arena's are compared per $10 trade.

`GET /api/arena/reality` lists every matched trade; `/colony` shows the verdict
on PRISM. After 20 matched trades it reads **matches**, **unclear**,
**arena too strict**, or **arena too optimistic**. The last one means the arena
overstates profit: don't go live on an arena result until that is explained.

## AI agents (`agents.js`, on when `AGENTS_ENABLED=true`)

Every `AGENTS_EVERY_MIN` minutes (default 180), using `ANTHROPIC_API_KEY`:

- **FORGE** and **VECTOR** each propose one BTC recipe, **DUGOUT** one sports
  recipe (once the sports recorder has data).
- At most `AGENTS_MAX_ACTIVE` (default 15) recipes are active at once: every
  extra strategy raises the odds that one looks good by luck.
- **PRISM** retires recipes with 60+ trades whose best-case estimate still loses.
- **The Council** (FORGE, VECTOR, PRISM, DUGOUT, WARDEN) votes on which
  strategy with 30+ trades gets the next forward-test focus.

Agents write **recipes, not code** (`spec.js`): a family, a side
(favorite / underdog / up / down / fair_value), an entry window, a price band
and optional take-profit / stop-loss. Every recipe is validated against fixed
bounds before it is stored (`arena:specs` in Redis), so nothing an agent writes
is ever executed. Agents cannot change settings, place orders or touch keys.
`GET /api/arena/specs` lists recipes; `GET /api/arena/agents` shows the last run.

## Sports recorder (`sports-recorder.js`, on when `ARENA_SPORTS=true`)

Every 5 minutes it saves the price of upcoming moneylines (up to 48h before
start, using the sports bot's own cached fetch) until the game starts, then
the result. Sports strategies see `msLeft` as the time until the game starts.
