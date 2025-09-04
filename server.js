// server.js (ESM) — Apple IAP validator for GameMaker
// - Uses verifyReceipt to bootstrap originalTransactionId (with shared secret)
// - Uses App Store Server API to determine active/lapsed
// - Includes /verify_by_oid if you already have an original_transaction_id
// - Adds /diag for non-sensitive health/config checks

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import appleLib from "app-store-server-library";

const {
  AppStoreServerAPIClient,
  Environment: AppleEnv,
  decodeRenewalInfo,
  decodeTransaction
} = appleLib;

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- ENV handling (no secrets logged) ----
const ENV = {
  NODE_ENV: process.env.NODE_ENV || "sandbox", // "sandbox" or "production"
  PORT: process.env.PORT || 8080,

  APPLE_ISSUER_ID: process.env.APPLE_ISSUER_ID || "",
  APPLE_KEY_ID: process.env.APPLE_KEY_ID || "",
  APPLE_BUNDLE_ID: process.env.APPLE_BUNDLE_ID || "",

  // Provide one of these:
  APPLE_PRIVATE_KEY: process.env.APPLE_PRIVATE_KEY || "",
  APPLE_PRIVATE_KEY_B64: process.env.APPLE_PRIVATE_KEY_B64 || "",

  // Strongly recommended for subscriptions:
  APPLE_SHARED_SECRET: process.env.APPLE_SHARED_SECRET || ""
};

function loadPem() {
  try {
    if (ENV.APPLE_PRIVATE_KEY_B64) {
      return Buffer.from(ENV.APPLE_PRIVATE_KEY_B64, "base64").toString("utf8");
    }
    return ENV.APPLE_PRIVATE_KEY || "";
  } catch {
    return "";
  }
}

function configCheck() {
  const pem = loadPem();
  const issues = [];
  if (!ENV.APPLE_ISSUER_ID) issues.push("APPLE_ISSUER_ID missing");
  if (!ENV.APPLE_KEY_ID) issues.push("APPLE_KEY_ID missing");
  if (!ENV.APPLE_BUNDLE_ID) issues.push("APPLE_BUNDLE_ID missing");
  if (!pem) issues.push("APPLE_PRIVATE_KEY / APPLE_PRIVATE_KEY_B64 missing/bad");
  if (pem && !pem.startsWith("-----BEGIN PRIVATE KEY-----")) {
    issues.push("Private key does not start with BEGIN PRIVATE KEY (PEM formatting?)");
  }
  return {
    ok: issues.length === 0,
    issues,
    pemStart: pem ? pem.split("\n")[0] : "NONE",
    pemLen: pem.length
  };
}

function appleClient() {
  const pem = loadPem();
  const env = ENV.NODE_ENV === "production" ? AppleEnv.Production : AppleEnv.Sandbox;
  return new AppStoreServerAPIClient(
    pem,
    ENV.APPLE_ISSUER_ID,
    ENV.APPLE_KEY_ID,
    ENV.APPLE_BUNDLE_ID,
    env
  );
}

// --- verifyReceipt bootstrap: derive original_transaction_id from app receipt ---
async function getOriginalTransactionIdFromReceipt(receiptB64) {
  try {
    if (!receiptB64 || typeof receiptB64 !== "string" || receiptB64.length < 20) {
      return { originalTxId: null, debug: { status: 21002, note: "receipt missing/too short" } };
    }

    const baseBody = {
      "receipt-data": receiptB64,
      "exclude-old-transactions": false
    };
    // Add shared secret for auto-renewable subscriptions
    const body = ENV.APPLE_SHARED_SECRET
      ? { ...baseBody, password: ENV.APPLE_SHARED_SECRET }
      : baseBody;

    const urlProd = "https://buy.itunes.apple.com/verifyReceipt";
    const urlSandbox = "https://sandbox.itunes.apple.com/verifyReceipt";
    const startUrl = ENV.NODE_ENV === "production" ? urlProd : urlSandbox;

    async function post(u) {
      const r = await fetch(u, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const t = await r.text();
      let json;
      try { json = JSON.parse(t); } catch { json = { status: "NON_JSON", raw: t.slice(0, 200) }; }
      return json;
    }

    let json = await post(startUrl);
    // Handle environment mismatches
    if (json.status === 21007) json = await post(urlSandbox);
    if (json.status === 21008) json = await post(urlProd);

    if (json.status === 0 && Array.isArray(json.latest_receipt_info)) {
      // Use latest transaction by expires_date_ms
      const latest = json.latest_receipt_info.reduce((a, b) =>
        Number(a.expires_date_ms || 0) > Number(b.expires_date_ms || 0) ? a : b
      );
      const originalTxId = latest?.original_transaction_id || null;
      return { originalTxId, debug: { status: json.status, envTried: ENV.NODE_ENV } };
    }

    return {
      originalTxId: null,
      debug: { status: json.status, envTried: ENV.NODE_ENV, hasLatest: Array.isArray(json.latest_receipt_info) }
    };
  } catch (e) {
    return { originalTxId: null, debug: { error: String(e?.message || e) } };
  }
}

// --- Decide active/lapsed from Server API statuses ---
function decideActiveFromStatuses(statusResponse, targetProductId) {
  let newest = null;
  const seen = new Set();

  for (const group of statusResponse?.data ?? []) {
    for (const item of group.lastTransactions ?? []) {
      const tx = decodeTransaction(item.signedTransactionInfo);
      const rn = decodeRenewalInfo(item.signedRenewalInfo);

      if (tx?.productId) seen.add(tx.productId);
      if (targetProductId && tx?.productId !== targetProductId) continue;

      const now = Date.now();
      const expiresMs = Number(tx?.expiresDate || 0);
      const cancelled = Boolean(tx?.revocationDate) || Boolean(tx?.cancellationDate);
      const graceMs = rn?.gracePeriodExpiresDate ? Number(rn.gracePeriodExpiresDate) : 0;
      const active = !cancelled && ((expiresMs > now) || (graceMs > now));

      const candidate = { productId: tx?.productId || null, expiresAt: expiresMs || 0, active };
      if (!newest || candidate.expiresAt > newest.expiresAt) newest = candidate;
    }
  }

  if (!newest) return { active: false, reason: "NO_TRANSACTIONS", debug: { seenProducts: [...seen] } };
  newest.debug = { seenProducts: [...seen] };
  return newest;
}

// ---- Diagnostics ----
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/diag", (_req, res) => {
  const chk = configCheck();
  res.json({
    ok: chk.ok,
    issues: chk.issues,
    env: {
      NODE_ENV: ENV.NODE_ENV,
      hasIssuerId: !!ENV.APPLE_ISSUER_ID,
      hasKeyId: !!ENV.APPLE_KEY_ID,
      hasBundleId: !!ENV.APPLE_BUNDLE_ID,
      hasSharedSecret: !!ENV.APPLE_SHARED_SECRET,
      keyLen: chk.pemLen,
      keyStartsWith: chk.pemStart
    }
  });
});

// ---- Main: verify using receipt (bootstrap path) ----
app.post("/verify_apple_receipt", async (req, res) => {
  try {
    const { receipt_b64, product_id } = req.body || {};
    if (!receipt_b64) {
      return res.status(400).json({ active: false, reason: "MISSING_RECEIPT" });
    }

    // Step 1: try to get original tx id from receipt
    const info = await getOriginalTransactionIdFromReceipt(receipt_b64);
    if (!info?.originalTxId) {
      return res.json({
        active: false,
        reason: "NO_ORIGINAL_TRANSACTION_ID",
        debug: {
          ...info?.debug,
          receiptLen: (req.body?.receipt_b64 || "").length
        }
      });
    }

    // Step 2: Server API for authoritative status
    let statuses;
    try {
      const client = appleClient();
      statuses = await client.getAllSubscriptionStatuses(info.originalTxId);
    } catch (e) {
      const httpStatusCode = e?.httpStatusCode || 0;
      const apiError = e?.apiError || null;
      return res.status(500).json({
        active: false,
        reason: "APPLE_SERVER_API_ERROR",
        error: String(e?.message || e),
        debug: {
          httpStatusCode,
          apiError,
          env: ENV.NODE_ENV,
          keyId: ENV.APPLE_KEY_ID,
          issuerId: ENV.APPLE_ISSUER_ID ? ENV.APPLE_ISSUER_ID.slice(0, 8) + "..." : ""
        }
      });
    }

    // Step 3: decide
    const d = decideActiveFromStatuses(statuses, product_id);
    return res.json({
      active: d.active,
      productId: d.productId || product_id || null,
      expiresAt: d.expiresAt || null,
      debug: d.debug || null
    });
  } catch (e) {
    return res.status(500).json({ active: false, reason: "SERVER_ERROR", error: String(e?.message || e) });
  }
});

// ---- Direct: verify using original_transaction_id (preferred once known) ----
app.post("/verify_by_oid", async (req, res) => {
  try {
    const { original_transaction_id, product_id } = req.body || {};
    if (!original_transaction_id) {
      return res.status(400).json({ active: false, reason: "MISSING_ORIGINAL_TRANSACTION_ID" });
    }

    let statuses;
    try {
      const client = appleClient();
      statuses = await client.getAllSubscriptionStatuses(original_transaction_id);
    } catch (e) {
      const httpStatusCode = e?.httpStatusCode || 0;
      const apiError = e?.apiError || null;
      return res.status(500).json({
        active: false,
        reason: "APPLE_SERVER_API_ERROR",
        error: String(e?.message || e),
        debug: { httpStatusCode, apiError, env: ENV.NODE_ENV }
      });
    }

    const d = decideActiveFromStatuses(statuses, product_id);
    return res.json({
      active: d.active,
      productId: d.productId || product_id || null,
      expiresAt: d.expiresAt || null,
      debug: d.debug || null
    });
  } catch (e) {
    return res.status(500).json({ active: false, reason: "SERVER_ERROR", error: String(e?.message || e) });
  }
});

// ---- Start ----
app.listen(ENV.PORT, () => {
  console.log(`IAP server listening on port ${ENV.PORT} (${ENV.NODE_ENV})`);
});
