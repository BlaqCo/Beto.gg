/**
 * kelly.js
 * Same logic dry or live. No artificial dampening.
 * Signal weight boosted so real signals create real edge.
 */

function impliedProb(price) {
  return price > 1 ? price / 100 : price;
}

function estimateTrueProb(signals, sentiment, marketImpl, isYes) {
  const { bias, confidence } = signals;
  let prob = marketImpl;

  // Core signal adjustment — boosted weight
  // bias=0.5, conf=0.7 on a YES → shifts prob by +0.175
  // bias=0.2, conf=0.13 on a YES → shifts prob by +0.026 (still meaningful)
  const signalAdj = (isYes ? bias : -bias) * confidence * 0.55;
  prob += signalAdj;

  // Extra boost when confidence is high
  if (confidence > 0.5) {
    const extra = (isYes ? bias : -bias) * (confidence - 0.5) * 0.20;
    prob += extra;
  }

  // LLM sentiment blend
  if (sentiment?.probability != null) {
    const llm = isYes ? sentiment.probability : 1 - sentiment.probability;
    prob = prob * 0.65 + llm * 0.35;
  }

  return Math.max(0.03, Math.min(0.97, prob));
}

function kelly(trueP, impliedP) {
  const b = 1 / impliedP - 1;
  return (b * trueP - (1 - trueP)) / b;
}

export function sizeBet(signals, sentiment, market) {
  const yes = market.tokens?.find(t => t.outcome === "Yes");
  const no  = market.tokens?.find(t => t.outcome === "No");
  if (!yes || !no) return { shouldBet: false, reasoning: "No token prices" };

  const yesImpl = impliedProb(yes.price);
  const noImpl  = impliedProb(no.price);
  const yesTrue = estimateTrueProb(signals, sentiment, yesImpl, true);
  const noTrue  = estimateTrueProb(signals, sentiment, noImpl, false);
  const yesEdge = yesTrue - yesImpl;
  const noEdge  = noTrue  - noImpl;

  let side, edge, trueProb, impliedP;
  if (yesEdge >= noEdge && yesEdge > 0) {
    side = "YES"; edge = yesEdge; trueProb = yesTrue; impliedP = yesImpl;
  } else if (noEdge > 0) {
    side = "NO"; edge = noEdge; trueProb = noTrue; impliedP = noImpl;
  } else {
    return { shouldBet: false, reasoning: `No edge — YES:${(yesEdge*100).toFixed(1)}% NO:${(noEdge*100).toFixed(1)}%` };
  }

  // Min edge: 1.5% — tight enough to catch real opportunities
  const MIN_EDGE = parseFloat(process.env.MIN_EDGE || "0.015");
  if (edge < MIN_EDGE) {
    return { shouldBet: false, edge, reasoning: `Edge ${(edge*100).toFixed(1)}% < min ${(MIN_EDGE*100).toFixed(1)}%` };
  }

  const k = kelly(trueProb, impliedP);
  if (k <= 0.003) {
    return { shouldBet: false, edge, reasoning: `Kelly ${(k*100).toFixed(2)}% too small` };
  }

  const KELLY_F  = parseFloat(process.env.KELLY_FRACTION || "0.30");
  const BANKROLL = parseFloat(process.env.BANKROLL || "40");
  const MAX_BET  = parseFloat(process.env.MAX_BET_SIZE || "8");

  const raw = BANKROLL * k * KELLY_F;
  const betSize = parseFloat(Math.max(1, Math.min(raw, MAX_BET)).toFixed(2));

  return {
    shouldBet: true,
    side,
    betSize,
    edge,
    trueProb,
    impliedProb: impliedP,
    kellyRaw: k,
    reasoning: `${side} edge:${(edge*100).toFixed(1)}% kelly:${(k*100).toFixed(1)}% → $${betSize}`,
  };
}
