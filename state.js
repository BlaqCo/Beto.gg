/**
 * state.js
 * Dry run always starts with a fresh $40 balance on boot.
 * Live mode tracks real P&L against actual deposited balance.
 */

const STARTING_BALANCE = parseFloat(process.env.BANKROLL || "40");
const IS_DRY = process.env.DRY_RUN !== "false";

const state = {
  bets: [],
  pnl: 0,
  totalWagered: 0,
  wins: 0,
  losses: 0,
  scalps: 0,
  scansCompleted: 0,
  startedAt: new Date().toISOString(),
  lastScan: null,
  activeBets: new Map(),
  // Dry run tracks remaining balance explicitly
  dryBalance: STARTING_BALANCE,
};

console.log(`💰 State initialized | Starting balance: $${STARTING_BALANCE} | Mode: ${IS_DRY ? "DRY RUN" : "LIVE"}`);

export function recordBet({ market, side, betSize, edge, trueProbability, impliedProbability, orderId, entryPrice, strategy, reasoning }) {
  const bet = {
    id: `bet_${Date.now()}`,
    orderId,
    marketConditionId: market.conditionId || market.condition_id,
    marketQuestion: market.question,
    side,
    betSize,
    edge,
    trueProbability,
    impliedProbability,
    entryPrice: entryPrice || impliedProbability,
    strategy: strategy || "UNKNOWN",
    reasoning: reasoning || "",
    placedAt: new Date().toISOString(),
    status: "open",
    pnl: null,
    exitReason: null,
    exitPrice: null,
  };

  state.bets.push(bet);
  state.totalWagered += betSize;
  state.dryBalance -= betSize; // deduct from dry balance immediately
  state.activeBets.set(bet.marketConditionId, bet);
  return bet;
}

export function closeBet(conditionId, { exitPrice, reason, pnl }) {
  const bet = state.activeBets.get(conditionId);
  if (!bet) return null;

  bet.exitPrice = exitPrice;
  bet.exitReason = reason;
  bet.pnl = pnl;
  bet.closedAt = new Date().toISOString();

  if (pnl > 0) { state.wins++; bet.status = "won"; }
  else { state.losses++; bet.status = "lost"; }
  if (reason === "take_profit") state.scalps++;

  state.pnl += pnl;
  state.dryBalance += bet.betSize + pnl; // return stake + profit (or stake - loss)
  state.activeBets.delete(conditionId);
  return bet;
}

export function hasActiveBet(conditionId) { return state.activeBets.has(conditionId); }
export function getActiveBet(conditionId) { return state.activeBets.get(conditionId); }
export function getAllActiveBets() { return Array.from(state.activeBets.values()); }
export function recordScan() { state.scansCompleted++; state.lastScan = new Date().toISOString(); }

export function getDryBalance() { return Math.max(0, state.dryBalance); }

export function getStats() {
  const total = state.wins + state.losses;
  return {
    uptime: state.startedAt,
    lastScan: state.lastScan,
    scansCompleted: state.scansCompleted,
    betsPlaced: state.bets.length,
    activeBets: state.activeBets.size,
    totalWagered: state.totalWagered.toFixed(2),
    pnl: state.pnl.toFixed(2),
    wins: state.wins,
    losses: state.losses,
    scalps: state.scalps,
    winRate: total > 0 ? ((state.wins / total) * 100).toFixed(1) + "%" : "N/A",
    startingBalance: STARTING_BALANCE,
    currentBalance: Math.max(0, STARTING_BALANCE + state.pnl).toFixed(2),
    dryBalance: getDryBalance().toFixed(2),
  };
}

export function getAllBets() { return state.bets; }
