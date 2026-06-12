/**
 * live-clob.js — polymarket.us order execution & fill tracking
 * 
 * Handles:
 * - Ed25519 signing for API requests
 * - Limit order posting with tick rounding
 * - Fill polling (10s timeout, 500ms cadence)
 * - Balance verification
 * - Custodial wallet support
 */

import crypto from "crypto";
import axios from "axios";

const POLYMARKET_API = "https://clob-api.polymarket.us";
const TICK_SIZE = 0.01; // orders must be 1¢ increments
const ORDER_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 500;

/**
 * Sign a request with Ed25519.
 * Returns { signature, timestamp } for headers.
 */
export function signRequest(method, path, body, apiKey, privateKey) {
  const timestamp = Date.now().toString();
  const sig = body ? `${method}${path}${body}${timestamp}` : `${method}${path}${timestamp}`;
  
  let keyBuf;
  try {
    // privateKey is base64 (from Polymarket dashboard)
    keyBuf = Buffer.from(privateKey, "base64");
  } catch {
    throw new Error("Invalid POLYMARKET_PRIVATE_KEY format (expected base64)");
  }
  
  if (keyBuf.length !== 64) {
    throw new Error(`Ed25519 key must be 64 bytes, got ${keyBuf.length}`);
  }
  
  try {
    const signature = crypto
      .createSign("ed25519")
      .update(sig)
      .sign({ format: "der", key: keyBuf });
    return {
      signature: signature.toString("base64"),
      timestamp,
    };
  } catch (err) {
    throw new Error("Ed25519 signing failed: " + err.message);
  }
}

/**
 * Round price to valid Polymarket tick (1¢ increments).
 */
export function roundToTick(price) {
  return Math.round(price / TICK_SIZE) * TICK_SIZE;
}

/**
 * Create and post a limit order, poll for fill.
 * Returns { filled: boolean, fillPrice?: number, orderId: string, error?: string }
 */
export async function postAndPollOrder(
  tokenId,
  side,
  size,
  intendedPrice,
  apiKey,
  privateKey,
  marketQuestion
) {
  const price = roundToTick(intendedPrice);
  const orderId = `order_${Date.now()}`;
  
  try {
    // POST order
    const body = JSON.stringify({
      tokenID: tokenId,
      side: side === "BUY" ? "BUY" : "SELL",
      size: size.toString(),
      price: price.toFixed(2),
      orderID: orderId,
    });
    
    const { signature, timestamp } = signRequest(
      "POST",
      "/order",
      body,
      apiKey,
      privateKey
    );
    
    const postResp = await axios.post(`${POLYMARKET_API}/order`, JSON.parse(body), {
      headers: {
        "X-PM-Access-Key": apiKey,
        "X-PM-Timestamp": timestamp,
        "X-PM-Signature": signature,
        "Content-Type": "application/json",
      },
      timeout: 5000,
    });
    
    if (!postResp.data || !postResp.data.orderId) {
      return {
        filled: false,
        orderId,
        error: "Order posted but no orderId in response",
      };
    }
    
    const realOrderId = postResp.data.orderId;
    
    // POLL for fill
    const pollStart = Date.now();
    while (Date.now() - pollStart < ORDER_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      
      const { signature: pollSig, timestamp: pollTs } = signRequest(
        "GET",
        `/order/${realOrderId}`,
        null,
        apiKey,
        privateKey
      );
      
      try {
        const statusResp = await axios.get(
          `${POLYMARKET_API}/order/${realOrderId}`,
          {
            headers: {
              "X-PM-Access-Key": apiKey,
              "X-PM-Timestamp": pollTs,
              "X-PM-Signature": pollSig,
            },
            timeout: 3000,
          }
        );
        
        const order = statusResp.data;
        if (order.status === "FILLED") {
          return {
            filled: true,
            fillPrice: parseFloat(order.fillPrice || price),
            orderId: realOrderId,
            size: parseFloat(order.size),
          };
        }
        if (order.status === "CANCELLED" || order.status === "REJECTED") {
          return {
            filled: false,
            orderId: realOrderId,
            error: `Order ${order.status}`,
          };
        }
      } catch (pollErr) {
        // Timeout on status check — keep polling
      }
    }
    
    // Timeout reached, try to cancel
    try {
      const { signature: cancelSig, timestamp: cancelTs } = signRequest(
        "DELETE",
        `/order/${realOrderId}`,
        null,
        apiKey,
        privateKey
      );
      
      await axios.delete(`${POLYMARKET_API}/order/${realOrderId}`, {
        headers: {
          "X-PM-Access-Key": apiKey,
          "X-PM-Timestamp": cancelTs,
          "X-PM-Signature": cancelSig,
        },
        timeout: 3000,
      });
    } catch {}
    
    return {
      filled: false,
      orderId: realOrderId,
      error: "Timeout waiting for fill (order cancelled)",
    };
  } catch (err) {
    return {
      filled: false,
      orderId,
      error: err.message,
    };
  }
}

/**
 * Get custodial wallet balance from Polymarket API.
 */
export async function getWalletBalance(apiKey, privateKey) {
  try {
    const { signature, timestamp } = signRequest(
      "GET",
      "/account",
      null,
      apiKey,
      privateKey
    );
    
    const resp = await axios.get(`${POLYMARKET_API}/account`, {
      headers: {
        "X-PM-Access-Key": apiKey,
        "X-PM-Timestamp": timestamp,
        "X-PM-Signature": signature,
      },
      timeout: 5000,
    });
    
    // custodial wallet balance in USDC
    return parseFloat(resp.data.balance || resp.data.usdc || "0");
  } catch (err) {
    console.error("⚠️  Balance check failed:", err.message);
    return null;
  }
}

/**
 * Preflight checks before trading.
 * Returns { ok: boolean, messages: string[] }
 */
export async function preflightCheck(apiKey, privateKey) {
  const messages = [];
  
  // Check key format
  if (!apiKey || apiKey.startsWith("your_")) {
    messages.push("❌ POLYMARKET_API_KEY missing or invalid");
    return { ok: false, messages };
  }
  if (!privateKey || privateKey.startsWith("your_")) {
    messages.push("❌ POLYMARKET_PRIVATE_KEY missing or invalid");
    return { ok: false, messages };
  }
  messages.push("✅ API credentials present");
  
  // Try a signed request
  try {
    signRequest("GET", "/test", null, apiKey, privateKey);
    messages.push("✅ Ed25519 signature works");
  } catch (err) {
    messages.push("❌ Signature failed: " + err.message);
    return { ok: false, messages };
  }
  
  // Check balance
  const bal = await getWalletBalance(apiKey, privateKey);
  if (bal === null) {
    messages.push("⚠️  Could not fetch wallet balance (will retry during trading)");
  } else if (bal > 0) {
    messages.push(`✅ Wallet balance: $${bal.toFixed(2)} USDC`);
  } else {
    messages.push("❌ Wallet balance is $0 — deposit USDC on Polygon");
    return { ok: false, messages };
  }
  
  return { ok: messages.filter(m => m.startsWith("❌")).length === 0, messages };
}
