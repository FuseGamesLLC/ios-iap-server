// server.js (CommonJS, hardened diagnostics)
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const {
  AppStoreServerAPIClient,
  Environment: AppleEnv,
  decodeRenewalInfo,
  decodeTransaction,
} = require("app-store-server-library");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- Load envs (no secrets logged) ----
const ENV = {
  NODE_ENV: process.env.NODE_ENV || "sandbox",
  PORT: process.env.PORT || 8080,
  APPLE_ISSUER_ID: process.env.APPLE_ISSUER_ID || "",
  APPLE_KEY_ID: process.env.APPLE_KEY_ID || "",
  APPLE_BUNDLE_ID: process.env.APPLE_BUNDLE_ID || "",
  // We support either raw PEM or base64 version of the .p8
  APPLE_PRIVATE_KEY: process.env.APPLE_PRIVATE_KEY || "",
  APPLE_PRIVATE_KEY_B64: process.env.APPLE_PRIVATE_KEY_B64 || ""
};

function loadPem() {
  try {
    if (ENV.APPLE_PRIVATE_KEY_B64) {
      const pem = Buffer.from(ENV.APPLE_PRIVATE_KEY_B64, "base64").toString("utf8");
      return pem;
    }
    return ENV.APPLE_PRIVATE_KEY || "";
  } catch (e) {
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
    issues.push("Private key does not start with BEGIN PRIVATE KEY (PEM formatting issue?)");
  }
  return { ok: issues.length === 0, issues, pemStart: pem ? pem.split("\n")[0] : "NONE", pemLen: pem.length };
}

function appleClient() {
  const pem = loadPem();
  const env = ENV.NODE_ENV === "production" ? AppleEnv.Production : AppleEnv.Sandbox;
  return new AppStoreServerAPIClient(pem, ENV.APPLE_ISSUER_ID, ENV.APPLE_KEY_ID, ENV.APPLE_BUNDLE_ID, env);
}

// --- Helper: verifyReceipt bootstrap for original_transaction_id ---
async function getOriginalTransactionIdFromReceipt(receiptB64) {
  try {
    if (!receiptB64 || typeof receiptB64 !== "string" || receiptB64.length < 20) {
      return { originalTxId: null, debug: { status: 21002, note: "receipt missing or too short" } }; // 21002 ~ malformed
    }

    const body = { "receipt-data": receiptB64, "exclude-old-transactions": false };
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
      // Some hosts return HTML on errors; guard parse:
      let json;
      try { json = JSON.parse(t); } catch { json = { status: "NON_JSON", raw: t.slice(0, 200) }; }
      return json;
    }

    let json = await post(startUrl);
    if (json.status === 21007) json = await post(urlSandbox);
    if (json.status === 21008) json = await post(urlProd);

    if (json.status === 0 && Array.isArray(json.latest_receipt_info)) {
      const latest = json.latest_receipt_info.reduce((a, b) =>
        Number(a.expires_date_ms || 0) > Number(b.expires_date_ms || 0) ? a : b
      );
      const originalTxId = latest?.original_transaction_id || null;
      return { originalTxId, debug: { status: json.status, envTried: ENV.NODE_ENV } };
    }

    return { originalTxId: null, debug: { status: json.status, envTried: ENV.NODE_ENV, hasLatest: Array.isArray(json.latest_receipt_info) } };
  } catch (e) {
    return { originalTxId: null, debug: { error: String(e?.message || e) } };
  }
}

// --- Decide active/lapsed from Server API ---
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

// ---- Diagnostics endpoints ----
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
      keyLen: chk.pemLen,
      keyStartsWith: chk.pemStart
    }
  });
});

// ---- Main endpoint ----
app.post("/verify_apple_receipt", async (req, res) => {
  try {
    const { receipt_b64, product_id } = req.body || {};
    if (!receipt_b64) {
      return res.status(400).json({ active: false, reason: "MISSING_RECEIPT" });
    }

    // Step 1: get original tx id (or explain why not)
    const info = await getOriginalTransactionIdFromReceipt(receipt_b64);
    if (!info?.originalTxId) {
      return res.json({ active: false, reason: "NO_ORIGINAL_TRANSACTION_ID", debug: info?.debug || null });
    }

    // Step 2: call Apple Server API (authoritative) — only if we have a tx id
    let statuses;
    try {
      const client = appleClient();
      statuses = await client.getAllSubscriptionStatuses(info.originalTxId);
    } catch (e) {
      // Most common: 401 due to key problems — surface enough to diagnose
      const httpStatusCode = e?.httpStatusCode || 0;
      const apiError = e?.apiError || null;
      return res.status(500).json({
        active: false,
        reason: "APPLE_SERVER_API_ERROR",
        error: String(e?.message || e),
        debug: { httpStatusCode, apiError, env: ENV.NODE_ENV, keyId: ENV.APPLE_KEY_ID, issuerId: ENV.APPLE_ISSUER_ID.slice(0,8) + "..." }
      });
    }

    // Step 3: decide and reply
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
