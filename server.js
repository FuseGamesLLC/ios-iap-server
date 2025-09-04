// server.js (ESM) — iOS subscriptions verify flow with timeouts + diagnostics
// Node 18+ recommended. If on older Node, also: import fetch from "node-fetch";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import appleLib from "app-store-server-library";
// import morgan from "morgan";

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
// app.use(morgan("tiny"));

// ------------------------ Config ------------------------
const ENV = {
  NODE_ENV: process.env.NODE_ENV || "sandbox", // "sandbox" | "production"
  PORT: process.env.PORT || 8080,

  APPLE_ISSUER_ID: process.env.APPLE_ISSUER_ID || "",
  APPLE_KEY_ID: process.env.APPLE_KEY_ID || "",
  APPLE_BUNDLE_ID: process.env.APPLE_BUNDLE_ID || "",
  APPLE_PRIVATE_KEY: process.env.APPLE_PRIVATE_KEY || "",
  APPLE_PRIVATE_KEY_B64: process.env.APPLE_PRIVATE_KEY_B64 || "",

  // Required for /verifyReceipt with auto-renewable subs
  APPLE_SHARED_SECRET: process.env.APPLE_SHARED_SECRET || "",

  // Timeouts (ms)
  VERIFY_RECEIPT_TIMEOUT_MS: Number(process.env.VERIFY_RECEIPT_TIMEOUT_MS || 8000),
  SERVER_API_TIMEOUT_MS: Number(process.env.SERVER_API_TIMEOUT_MS || 8000)
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
  if (!ENV.APPLE_SHARED_SECRET) issues.push("APPLE_SHARED_SECRET missing (needed for /verifyReceipt)");
  if (!pem) issues.push("APPLE_PRIVATE_KEY / APPLE_PRIVATE_KEY_B64 missing/bad");
  if (pem && !pem.startsWith("-----BEGIN PRIVATE KEY-----")) {
    issues.push("Private key must start with -----BEGIN PRIVATE KEY-----");
  }
  if (pem && !pem.trim().endsWith("-----END PRIVATE KEY-----")) {
    issues.push("Private key must end with -----END PRIVATE KEY-----");
  }
  return {
    ok: issues.length === 0,
    issues,
    pemLen: pem.length,
    pemStart: pem ? pem.split("\n")[0] : "NONE",
    pemEnd: pem ? pem.split("\n").slice(-1)[0] : "NONE"
  };
}

function appleClient() {
  const pem = loadPem();
  const env = ENV.NODE_ENV === "production" ? AppleEnv.Production : AppleEnv.Sandbox;

  // Wrap the client calls with our own timeout via AbortController.
  // app-store-server-library uses undici under the hood and supports AbortSignal.
  return new AppStoreServerAPIClient(
    pem, ENV.APPLE_ISSUER_ID, ENV.APPLE_KEY_ID, ENV.APPLE_BUNDLE_ID, env
  );
}

// ------------------------ Utils ------------------------
function withTimeout(promise, ms, name = "operation") {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  // Many APIs accept { signal }. For others, we just race.
  return {
    signal: controller.signal,
    run: async (fn) => {
      try {
        const res = await Promise.race([
          fn(controller.signal),
          new Promise((_, rej) => {
            setTimeout(() => rej(new Error(`${name} timeout after ${ms}ms`)), ms);
          })
        ]);
        return res;
      } finally {
        clearTimeout(t);
      }
    }
  };
}

async function postJson(url, body, ms, name) {
  const timer = withTimeout(null, ms, name);
  try {
    // global fetch supports AbortSignal in Node 18+
    const r = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: timer.signal
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} timeout after ${ms}ms`)), ms))
    ]);
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { status: "NON_JSON", raw: t.slice(0, 500) }; }
  } catch (e) {
    return { status: "NETWORK_ERROR", error: String(e?.message || e) };
  }
}

// ------------------------ Apple: /verifyReceipt ------------------------
async function getOriginalTransactionIdFromReceipt(receiptB64) {
  try {
    if (!receiptB64 || typeof receiptB64 !== "string" || receiptB64.length < 20) {
      return { originalTxId: null, debug: { status: 21002, note: "receipt missing or too short" } };
    }

    const body = {
      "receipt-data": receiptB64,
      "exclude-old-transactions": false,
      "password": ENV.APPLE_SHARED_SECRET
    };

    const urlProd = "https://buy.itunes.apple.com/verifyReceipt";
    const urlSandbox = "https://sandbox.itunes.apple.com/verifyReceipt";
    const startUrl = ENV.NODE_ENV === "production" ? urlProd : urlSandbox;

    let json = await postJson(startUrl, body, ENV.VERIFY_RECEIPT_TIMEOUT_MS, "verifyReceipt");
    if (json.status === 21007) json = await postJson(urlSandbox, body, ENV.VERIFY_RECEIPT_TIMEOUT_MS, "verifyReceipt-sandbox");
    if (json.status === 21008) json = await postJson(urlProd, body, ENV.VERIFY_RECEIPT_TIMEOUT_MS, "verifyReceipt-prod");

    if (json.status === 0) {
      let originalTxId = null;

      if (Array.isArray(json.latest_receipt_info) && json.latest_receipt_info.length) {
        const latest = json.latest_receipt_info.reduce((a, b) =>
          Number(a.expires_date_ms || 0) > Number(b.expires_date_ms || 0) ? a : b
        );
        originalTxId = latest?.original_transaction_id || null;
      }

      if (!originalTxId && json.receipt && Array.isArray(json.receipt.in_app) && json.receipt.in_app.length) {
        const first = json.receipt.in_app[0];
        originalTxId = first?.original_transaction_id || null;
      }

      if (originalTxId) {
        return { originalTxId, debug: { status: 0, envTried: ENV.NODE_ENV } };
      }

      return { originalTxId: null, debug: { status: 0, note: "No original_transaction_id present" } };
    }

    // Bubble diagnostics (helps see NETWORK_ERROR / NON_JSON / 21004, etc.)
    return {
      originalTxId: null,
      debug: {
        status: json.status,
        hasLatest: Array.isArray(json.latest_receipt_info),
        hasReceipt: Boolean(json.receipt),
        message: json.message || null,
        error: json.error || null
      }
    };
  } catch (e) {
    return { originalTxId: null, debug: { error: String(e?.message || e) } };
  }
}

// ------------------------ Decide active ------------------------
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

// ------------------------ Diagnostics ------------------------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/ping", (_req, res) => res.type("text").send("pong")); // quick liveness check

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
      keyEndsWith: chk.pemEnd,
      timeouts: {
        verifyReceiptMs: ENV.VERIFY_RECEIPT_TIMEOUT_MS,
        serverApiMs: ENV.SERVER_API_TIMEOUT_MS
      }
    }
  });
});

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

    // Step 1: /verifyReceipt (with timeout)
    const info = await getOriginalTransactionIdFromReceipt(receipt_b64);
    if (!info?.originalTxId) {
      return res.status(200).json({
        active: false,
        reason: "NO_ORIGINAL_TRANSACTION_ID",
        debug: info?.debug || null
      });
    }

    // Step 2: App Store Server API (with timeout)
let statuses;
try {
  const client = appleClient();
  statuses = await Promise.race([
    client.getAllSubscriptionStatuses(info.originalTxId),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("getAllSubscriptionStatuses timeout")), ENV.SERVER_API_TIMEOUT_MS)
    )
  ]);
} catch (e) {
  const httpStatusCode = e?.httpStatusCode || 0;
  const apiError = e?.apiError || null;

      console.error("APPLE_SERVER_API_ERROR", {
        httpStatusCode,
        apiError,
        env: ENV.NODE_ENV,
        bundleId: ENV.APPLE_BUNDLE_ID,
        keyId: ENV.APPLE_KEY_ID,
        issuerId: ENV.APPLE_ISSUER_ID ? ENV.APPLE_ISSUER_ID.slice(0, 8) + "..." : "",
        msg: String(e?.message || e)
      });

      // 401 from Apple vs timeout/network → 504
      const code = String(e?.message || "").includes("timeout") ? 504 : (httpStatusCode || 500);
      return res.status(code).json({
        active: false,
        reason: "APPLE_SERVER_API_ERROR",
        error: String(e?.message || e),
        debug: { httpStatusCode, apiError, env: ENV.NODE_ENV }
      });
    }

    // Step 3: Decide active
    const d = decideActiveFromStatuses(statuses, product_id);
    return res.json({
      active: d.active,
      productId: d.productId || product_id || null,
      expiresAt: d.expiresAt || null,
      debug: d.debug || null
    });
  } catch (e) {
    console.error("SERVER_ERROR", e);
    return res.status(500).json({ active: false, reason: "SERVER_ERROR", error: String(e?.message || e) });
  }
});

// ------------------------ Start ------------------------
app.listen(ENV.PORT, () => {
  console.log(`IAP server listening on port ${ENV.PORT} (${ENV.NODE_ENV})`);
});
