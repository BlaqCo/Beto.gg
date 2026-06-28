/**
 * state.js — in-memory bet state
 * Dry run: fresh $200 paper balance on each boot.
 * Live: tracks P&L against real account.
 */

const STARTING_BALANCE = parseFloat(process.env.BANKROLL || "200");
const IS_DRY = process.env.DRY_RUN !== "false";

const state = {
  bets:           [],
  pnl:            0,
  totalWagered:   0,
  wins:           0,
  losses:         0,
  scansCompleted: 0,
  startedAt:      new Date().toISOString(),
  lastScan:       null,
  activeBets:     new Map(),  // slug → bet
  dryBalance:     STARTING_BALANCE,
};

console.log(`💰 State initialized | Starting balance: $${STARTING_BALANCE} | Mode: ${IS_DRY ? "DRY RUN" : "LIVE"}`);

export function recordBet({ market, side, betSize, edge, trueProbability,
  impliedProbability, orderId, entryPrice, strategy, reasoning,
  entryBtcPrice, entryCoin, sharpShooter, valueBet, strike, direction }) {

  const bet = {
    id:                 `bet_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    orderId,
    marketConditionId:  market.conditionId || market.condition_id || market.slug,
    marketQuestion:     market.question,
    side:               side || "YES",
    betSize,
    edge:               edge || 0,
    trueProbability,
    impliedProbability,
    entryPrice:         entryPrice || impliedProbability,
    strategy:           strategy || "SPORTS_ML",
    reasoning:          reasoning || "",
    entryBtcPrice:      entryBtcPrice || null,
    entryCoin:          entryCoin || "SPORT",
    sharpShooter:       sharpShooter || false,
    valueBet:           valueBet || false,
    strike:             strike || null,
    direction:          direction || null,
    placedAt:           new Date().toISOString(),
    status:             "open",
    pnl:                null,
    exitReason:         null,
    exitPrice:          null,
    closedAt:           null,
  };

  state.bets.push(bet);
  state.totalWagered += betSize;
  state.dryBalance   -= betSize;
  state.activeBets.set(bet.marketConditionId, bet);
  return bet;
}

export function closeBet(conditionId, { exitPrice, reason, pnl }) {
  const bet = state.activeBets.get(conditionId);
  if (!bet) return null;
  bet.exitPrice  = exitPrice;
  bet.exitReason = reason;
  bet.pnl        = pnl;
  bet.closedAt   = new Date().toISOString();
  bet.status     = pnl > 0 ? "won" : pnl < 0 ? "lost" : "push";
  if (pnl > 0) state.wins++;
  else if (pnl < 0) state.losses++;
  state.pnl        += pnl;
  state.dryBalance += bet.betSize + pnl; // return stake + net
  state.activeBets.delete(conditionId);
  return bet;
}

export function hasActiveBet(conditionId)     { return state.activeBets.has(conditionId); }
export function getActiveBet(conditionId)     { return state.activeBets.get(conditionId); }
export function getAllActiveBets()             { return Array.from(state.activeBets.values()); }
export function getDryBalance()               { return Math.max(0, state.dryBalance); }
export function getAllBets()                   { return state.bets; }

// Count total times we've ever entered a market (active + closed)
export function countBetsForMarket(conditionId) {
  return state.bets.filter(b =>
    b.marketConditionId === conditionId ||
    b.marketConditionId === conditionId.replace(":", "-")
  ).length;
}

export function recordScan() {
  state.scansCompleted++;
  state.lastScan = new Date().toISOString();
}

export function getStats() {
  const total = state.wins + state.losses;
  return {
    uptime:         state.startedAt,
    lastScan:       state.lastScan,
    scansCompleted: state.scansCompleted,
    betsPlaced:     state.bets.length,
    activeBets:     state.activeBets.size,
    totalWagered:   state.totalWagered.toFixed(2),
    pnl:            state.pnl.toFixed(2),
    wins:           state.wins,
    losses:         state.losses,
    winRate:        total > 0 ? ((state.wins / total) * 100).toFixed(1) + "%" : "N/A",
    startingBalance: STARTING_BALANCE,
    currentBalance:  (STARTING_BALANCE + state.pnl).toFixed(2),
    dryBalance:      getDryBalance().toFixed(2),
  };
}
