/**
 * sentiment.js — LLM-powered market sentiment scorer
 * Uses Claude to assess BTC direction probability.
 */

export async function scoreSentiment(signalData, market) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.startsWith("your_")) {
    return { sentimentBias: 0, reasoning: "No API key", adjustedProb: null };
  }

  const prompt = buildPrompt(signalData, market);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        system: `You are a quantitative crypto analyst. Respond ONLY with a JSON object, no markdown:
{"probability":<0.0-1.0>,"confidence":<0.0-1.0>,"bias":"bullish"|"bearish"|"neutral","reasoning":"one sentence"}`,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

    return {
      sentimentBias: parsed.bias === "bullish" ? parsed.confidence
                   : parsed.bias === "bearish" ? -parsed.confidence : 0,
      probability:  parsed.probability,
      confidence:   parsed.confidence,
      reasoning:    parsed.reasoning,
    };
  } catch (err) {
    return { sentimentBias: 0, reasoning: "Error: " + err.message, adjustedProb: null };
  }
}

function buildPrompt(signals, market) {
  const { currentPrice, bias, confidence } = signals;
  return `MARKET: "${market.question}"
BTC PRICE: $${currentPrice?.toLocaleString() || "unknown"}
SIGNAL BIAS: ${bias?.toFixed(3)} | CONFIDENCE: ${(confidence * 100)?.toFixed(0)}%
What is the probability the YES outcome resolves?`.trim();
}
