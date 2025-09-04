// server.js (ESM) — iOS subscriptions verify flow with robust diagnostics
// Node 18+ (global fetch). If on older Node, add: import fetch from "node-fetch";
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

// ------------------------ Environment ------------------------
const ENV = {
  NODE_ENV: process.env.NODE_ENV || "sandbox", // "sandbox" or "production"
  PORT: process.env.PORT || 8080,

  // App Store Server API (JWT) triplet
  APPLE_ISSUER_ID: process.env.APPLE_ISSUER_ID || "",
  APPLE_KEY_ID: process.env.APPLE_KEY_ID || "",
  APPLE_BUNDLE_ID: process.env.APPLE_BUNDLE_ID || "",
  APPLE_PRIVATE_KEY: process.env.APPLE_PRIVATE_KEY || "",
  APPLE_PRIVATE_KEY_B64: process.env.APPLE_PRIVATE_KEY_B64 || "",

  // Legacy /verifyReceipt shared secret (auto-renewable subscriptions)
  APPLE_SHARED_SECRET: process.env.APPLE_SHARED_SECRET || ""
};

function loadPem() {
  try {
    if (ENV.APPLE_PRIVATE_KEY_B64) {
      const pem = Buffer.from(ENV.APPLE_PRIVATE_KEY_B64, "base64").toString("utf8");
      return pem;
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
  if (!ENV.APPLE_SHARED_SECRET) issues.push("APPLE_SHARED_SECRET missing (required for /verifyReceipt)");
  if (!pem) issues.push("APPLE_PRIVATE_KEY / APPLE_PRIVATE_KEY_B64 missing/bad");
  if (pem && !pem.startsWith("-----BEGIN PRIVATE KEY-----")) {
    issues.push("Private key does not start with BEGIN PRIVATE KEY (PEM formatting issue?)");
  }
  if (pem && !pem.trim().endsWith("-----END PRIVATE KEY-----")) {
    issues.push("Private key does not end with END PRIVATE KEY");
  }
  const lenOk = pem.length >= 800 && pem.length <= 5000;
  if (pem && !lenOk) issues.push(`Private key length unexpected (${pem.length})`);
  return {
    ok: issues.length === 0,
    issues,
    pemStart: pem ? pem.split("\n")[0] : "NONE",
    pemEnd: pem ? pem.split("\n").slice(-1)[0] : "NONE",
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

// ------------------------ Helpers ------------------------
async function postVerifyReceipt(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { status: "NON_JSON", raw: t.slice(0, 500) };
  }
}

// --- Extract original_transaction_id via /verifyReceipt ---
async function getOriginalTransactionIdFromReceipt(receiptB64) {
  try {
    if (!receiptB64 || typeof receiptB64 !== "string" || receiptB64.length < 20) {
      return { originalTxId: null, debug: { status: 21002, note: "receipt missing or too short" } };
    }

    const body = {
      "receipt-data": receiptB64,
      "exclude-old-transactions": false,
      // REQUIRED for auto-renewable subs to avoid 21004:
      "password": ENV.APPLE_SHARED_SECRET
    };

    const urlProd = "https://buy.itunes.apple.com/verifyReceipt";
    const urlSandbox = "https://sandbox.itunes.apple.com/verifyReceipt";
    const startUrl = ENV.NODE_ENV === "production" ? urlProd : urlSandbox;

    let json = await postVerifyReceipt(startUrl, body);
    if (json.status === 21007) json = await postVerifyReceipt(urlSandbox, body);
    if (json.status === 21008) json = await postVerifyReceipt(urlProd, body);

    // Success path
    if (json.status === 0) {
      // Prefer latest_receipt_info for subscriptions
      let originalTxId = null;

      if (Array.isArray(json.latest_receipt_info) && json.latest_receipt_info.length) {
        // Use the most recent by expires_date_ms
        const latest = json.latest_receipt_info.reduce((a, b) =>
          Number(a.expires_date_ms || 0) > Number(b.expires_date_ms || 0) ? a : b
        );
        originalTxId = latest?.original_transaction_id || null;
      }

      // Fallback to receipt.in_app if needed
      if (!originalTxId && json.receipt && Array.isArray(json.receipt.in_app) && json.receipt.in_app.length) {
        // Often the earliest purchase has the original_transaction_id we need
        const first = json.receipt.in_app[0];
        originalTxId = first?.original_transaction_id || null;
      }

      if (originalTxId) {
        return { originalTxId, debug: { status: 0, envTried: ENV.NODE_ENV } };
      }

      return {
        originalTxId: null,
        debug: {
          status: 0,
          envTried: ENV.NODE_ENV,
          note: "No original_transaction_id in latest_receipt_info or receipt.in_app"
        }
      };
    }

    // Non-zero status — bubble it up (helps debug 21004/others)
    return {
      originalTxId: null,
      debug: {
        status: json.status,
        envTried: ENV.NODE_ENV,
        hasLatest: Array.isArray(json.latest_receipt_info),
        hasReceipt: Boolean(json.receipt),
        message: json.message || null
      }
    };
  } catch (e) {
    return { originalTxId: null, debug: { error: String(e?.message || e) } };
  }
}

// --- Decide active/lapsed from App Store Server API statuses ---
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

      const candidate = {
        productId: tx?.productId || null,
        expiresAt: expiresMs || 0,
        active
      };
      if (!newest || candidate.expiresAt > newest.expiresAt) newest = candidate;
    }
  }

  if (!newest) return { active: false, reason: "NO_TRANSACTIONS", debug: { seenProducts: [...seen] } };
  newest.debug = { seenProducts: [...seen] };
  return newest;
}

// ------------------------ Diagnostics ------------------------
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
      keyStartsWith: chk.pemStart,
      keyEndsWith: chk.pemEnd
    }
  });
});

// Checks for the most common 401 causes (sanity only; no secrets leaked)
app.get("/diag-apple-auth", (_req, res) => {
  const chk = configCheck();
  const pem = loadPem();
  res.json({
    ok: chk.ok,
    issues: chk.issues,
    issuerIdLen: (ENV.APPLE_ISSUER_ID || "").length,
    keyIdLen: (ENV.APPLE_KEY_ID || "").length,
    bundleId: ENV.APPLE_BUNDLE_ID,
    pemLen: pem.length,
    startsWith: pem.slice(0, 30),
    endsWith: pem.slice(-30),
    nodeEnv: ENV.NODE_ENV
  });
});

// ------------------------ Main endpoint ------------------------
app.post("/verify_apple_receipt", async (req, res) => {
  try {
    const { receipt_b64, product_id } = req.body || {};
    if (!receipt_b64) {
      return res.status(400).json({ active: false, reason: "MISSING_RECEIPT" });
    }

    // Step 1: Bootstrap original_transaction_id from /verifyReceipt
    const info = await getOriginalTransactionIdFromReceipt(receipt_b64);
    if (!info?.originalTxId) {
      return res.json({
        active: false,
        reason: "NO_ORIGINAL_TRANSACTION_ID",
        debug: info?.debug || null
      });
    }

    // Step 2: Query App Store Server API (authoritative)
    let statuses;
    try {
      const client = appleClient();
      statuses = await client.getAllSubscriptionStatuses(info.originalTxId);
    } catch (e) {
      const httpStatusCode = e?.httpStatusCode || 0;
      const apiError = e?.apiError || null;

      // Helpful logs for 401s (no secrets)
      console.error("APPLE_SERVER_API_ERROR", {
        httpStatusCode,
        apiError,
        env: ENV.NODE_ENV,
        bundleId: ENV.APPLE_BUNDLE_ID,
        keyId: ENV.APPLE_KEY_ID,
        issuerId: ENV.APPLE_ISSUER_ID ? ENV.APPLE_ISSUER_ID.slice(0, 8) + "..." : ""
      });

      return res.status(401 === httpStatusCode ? 401 : 500).json({
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

    // Step 3: Decide active state and respond
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

// ------------------------ Start ------------------------
app.listen(ENV.PORT, () => {
  console.log(`IAP server listening on port ${ENV.PORT} (${ENV.NODE_ENV})`);
});
