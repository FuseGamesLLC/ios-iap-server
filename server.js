// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import appleLib from "app-store-server-library";
const {
  AppStoreServerAPIClient,
  Environment: AppleEnv,
  decodeRenewalInfo,
  decodeTransaction,
} = appleLib;
dotenv.config();

const app = express();
app.use(cors()); // not required for native apps, harmless otherwise
app.use(express.json({ limit: "1mb" })); // our JSON body is small

// ---- env ----
const {
  APPLE_ISSUER_ID,
  APPLE_KEY_ID,
  APPLE_PRIVATE_KEY,
  APPLE_BUNDLE_ID,
  NODE_ENV,
  PORT = 8080,
} = process.env;

if (!APPLE_ISSUER_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY || !APPLE_BUNDLE_ID) {
  console.error("Missing Apple env vars. Check .env (ISSUER_ID, KEY_ID, PRIVATE_KEY, BUNDLE_ID).");
  process.exit(1);
}

// If your APPLE_PRIVATE_KEY is base64 instead of PEM, uncomment to decode:
// const PRIVATE_KEY_PEM = APPLE_PRIVATE_KEY.includes("BEGIN PRIVATE KEY")
//   ? APPLE_PRIVATE_KEY
//   : Buffer.from(APPLE_PRIVATE_KEY, "base64").toString("utf8");

const PRIVATE_KEY_PEM = APPLE_PRIVATE_KEY;

// Apple client for App Store Server API
function appleClient() {
  const env = NODE_ENV === "production" ? AppleEnv.Production : AppleEnv.Sandbox;
  return new AppStoreServerAPIClient(PRIVATE_KEY_PEM, APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_BUNDLE_ID, env);
}

// ---------- Helper 1: Only once per user: get original_transaction_id from base64 app receipt ----------
// verifyReceipt is deprecated, but Apple still documents it; we use it here as a bootstrap.
// If you see status 21007 (sandbox receipt to production URL) or 21008, we retry in the other env.
async function getOriginalTransactionIdFromReceipt(receiptB64) {
  const body = { "receipt-data": receiptB64, "exclude-old-transactions": false };

  // choose endpoint based on NODE_ENV
  let url = NODE_ENV === "production"
    ? "https://buy.itunes.apple.com/verifyReceipt"
    : "https://sandbox.itunes.apple.com/verifyReceipt";

  const post = async (u) => {
    const r = await fetch(u, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  };

  let json = await post(url);

  // Handle environment mismatch redirects
  if (json.status === 21007) { // sandbox receipt sent to production
    json = await post("https://sandbox.itunes.apple.com/verifyReceipt");
  } else if (json.status === 21008) { // production receipt sent to sandbox
    json = await post("https://buy.itunes.apple.com/verifyReceipt");
  }

  // Success (status 0). For auto-renewable subs, latest_receipt_info is an array.
  if (json.status === 0 && Array.isArray(json.latest_receipt_info)) {
    const latest = json.latest_receipt_info.reduce((a, b) =>
      Number(a.expires_date_ms || 0) > Number(b.expires_date_ms || 0) ? a : b
    );
    return latest?.original_transaction_id || null;
  }

  // no usable info// Replace the final return null;
  return { originalTxId: null, debug: { status: json.status, hasLatest: Array.isArray(json.latest_receipt_info), env: process.env.NODE_ENV } };
}

// ---------- Helper 2: Decide active/lapsed from Server API response ----------
function decideActiveFromStatuses(statusResponse, targetProductId) {
  let newest = null;

  for (const group of statusResponse?.data ?? []) {
    for (const item of group.lastTransactions ?? []) {
      // Each item has signedTransactionInfo (JWS) and signedRenewalInfo (JWS)
      const tx = decodeTransaction(item.signedTransactionInfo);
      const rn = decodeRenewalInfo(item.signedRenewalInfo);

      if (targetProductId && tx?.productId !== targetProductId) continue;

      const now = Date.now();
      const expiresMs = Number(tx?.expiresDate || 0);
      const cancelled = Boolean(tx?.revocationDate) || Boolean(tx?.cancellationDate);

      // Grace/billing retry: treat as active until gracePeriodExpiresDate
      const graceMs = rn?.gracePeriodExpiresDate ? Number(rn.gracePeriodExpiresDate) : 0;
      const inGrace = graceMs > now;

      const active = !cancelled && ((expiresMs > now) || inGrace);

      const candidate = {
        productId: tx?.productId || null,
        expiresAt: expiresMs || 0,
        active,
      };

      if (!newest || candidate.expiresAt > newest.expiresAt) newest = candidate;
    }
  }

  // If no transactions found, default to not active
  return newest || { active: false, reason: "NO_TRANSACTIONS" };
}

// ---------- Routes ----------
app.get("/healthz", (_, res) => res.json({ ok: true }));

// POST /verify_apple_receipt  { receipt_b64, product_id }
app.post("/verify_apple_receipt", async (req, res) => {
  try {
    const { receipt_b64, product_id } = req.body || {};
    if (!receipt_b64) return res.status(400).json({ error: "Missing receipt_b64" });

    // 1) Bootstrap original_transaction_id once per user
    const originalTransactionId = await getOriginalTransactionIdFromReceipt(receipt_b64);
    if (!originalTransactionId) {
      return res.json({ active: false, reason: "NO_ORIGINAL_TRANSACTION_ID" });
    }

    // 2) Query Apple App Store Server API (authoritative subscription state)
    const client = appleClient();
    const statuses = await client.getAllSubscriptionStatuses(originalTransactionId); // official endpoint
    // Docs: "Get All Subscription Statuses" returns active/expired/grace/retry states. 
    // We'll condense to a simple decision. :contentReference[oaicite:5]{index=5}

    // 3) Decide active/lapsed for your product
    const decision = decideActiveFromStatuses(statuses, product_id);

    // 4) Reply with a tiny JSON your GameMaker code can use directly
    return res.json({
      active: decision.active,
      productId: decision.productId || product_id || null,
      expiresAt: decision.expiresAt || null,
    });
  } catch (e) {
    console.error("VERIFY_ERROR:", e);
    return res.status(500).json({ active: false, reason: "SERVER_ERROR", error: String(e?.message || e) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => console.log(`IAP server listening on port ${PORT} (${NODE_ENV})`));

