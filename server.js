// server.js (ESM) — verifyReceipt-only flow for iOS subscriptions
// Node 18+ recommended (global fetch). If on older Node, add: import fetch from "node-fetch";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ------------------------ Config ------------------------
const ENV = {
  NODE_ENV: process.env.NODE_ENV || "sandbox",   // "sandbox" | "production"
  PORT: Number(process.env.PORT || 8080),

  // REQUIRED for auto-renewable subs with /verifyReceipt
  APPLE_SHARED_SECRET: process.env.APPLE_SHARED_SECRET || "",

  // Timeouts (ms)
  VERIFY_RECEIPT_TIMEOUT_MS: Number(process.env.VERIFY_RECEIPT_TIMEOUT_MS || 8000),
};

// Basic config sanity
function configCheck() {
  const issues = [];
  if (!ENV.APPLE_SHARED_SECRET) issues.push("APPLE_SHARED_SECRET missing (required for /verifyReceipt)");
  return { ok: issues.length === 0, issues };
}

// Simple GETs to confirm the server is alive and env is sane
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/diag", (_req, res) => {
  const chk = configCheck();
  res.json({
    ok: chk.ok,
    issues: chk.issues,
    env: {
      NODE_ENV: ENV.NODE_ENV,
      hasSharedSecret: !!ENV.APPLE_SHARED_SECRET,
      timeouts: { verifyReceiptMs: ENV.VERIFY_RECEIPT_TIMEOUT_MS }
    }
  });
});

// ------------------------ Helpers ------------------------
async function postJsonWithTimeout(url, body, timeoutMs, name = "verifyReceipt") {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await r.text();
    try { return JSON.parse(text); }
    catch { return { status: "NON_JSON", raw: text.slice(0, 500) }; }
  } catch (e) {
    return { status: "NETWORK_ERROR", error: `${name}: ${String(e?.message || e)}` };
  } finally {
    clearTimeout(t);
  }
}

// Decide entitlement from the verifyReceipt JSON (no Server API)
function decideActiveFromVerifyReceipt(json, targetProductId) {
  const now = Date.now();

  // Prefer latest_receipt_info for subscriptions; fallback to receipt.in_app
  const items = Array.isArray(json.latest_receipt_info) && json.latest_receipt_info.length
    ? json.latest_receipt_info
    : (json.receipt && Array.isArray(json.receipt.in_app) ? json.receipt.in_app : []);

  if (!items.length) {
    return { active: false, reason: "NO_TRANSACTIONS", debug: { seenProducts: [] } };
  }

  const seen = [...new Set(items.map(x => x.product_id).filter(Boolean))];
  const filtered = targetProductId ? items.filter(x => x.product_id === targetProductId) : items;

  if (!filtered.length) {
    return { active: false, reason: "PRODUCT_NOT_FOUND", debug: { seenProducts: seen } };
  }

  // Pick most recent by expires_date_ms (or purchase_date_ms if expires missing)
  const latest = filtered.reduce((a, b) => {
    const ea = Number(a.expires_date_ms || a.expires_date || a.purchase_date_ms || 0);
    const eb = Number(b.expires_date_ms || b.expires_date || b.purchase_date_ms || 0);
    return (eb > ea) ? b : a;
  });

  const expiresMs = Number(latest.expires_date_ms || latest.expires_date || 0);
  const cancelled = Boolean(latest.cancellation_date_ms || latest.cancellation_date);

  // Try to find grace period in pending_renewal_info (if present)
  let graceMs = 0;
  if (Array.isArray(json.pending_renewal_info)) {
    // product_id or auto_renew_product_id may be present
    const rn = json.pending_renewal_info.find(r =>
      r.product_id === latest.product_id || r.auto_renew_product_id === latest.product_id
    );
    if (rn && rn.grace_period_expires_date_ms) {
      graceMs = Number(rn.grace_period_expires_date_ms);
    }
  }

  const active = !cancelled && ((expiresMs > now) || (graceMs > now));

  return {
    active,
    productId: latest.product_id || null,
    expiresAt: expiresMs || null,
    debug: { seenProducts: seen, graceMs }
  };
}

// ------------------------ Main endpoint ------------------------
app.post("/verify_apple_receipt", async (req, res) => {
  try {
    const { receipt_b64, product_id } = req.body || {};
    if (!receipt_b64) {
      return res.status(400).json({ active: false, reason: "MISSING_RECEIPT" });
    }

    const chk = configCheck();
    if (!chk.ok) {
      return res.status(500).json({ active: false, reason: "CONFIG_ERROR", issues: chk.issues });
    }

    // Build body for /verifyReceipt
    const body = {
      "receipt-data": receipt_b64,
      "password": ENV.APPLE_SHARED_SECRET,          // REQUIRED for subscriptions
      "exclude-old-transactions": false
    };

    // Choose endpoint based on env; handle 21007/21008 swaps
    const urlProd = "https://buy.itunes.apple.com/verifyReceipt";
    const urlSandbox = "https://sandbox.itunes.apple.com/verifyReceipt";
    const startUrl = (ENV.NODE_ENV === "production") ? urlProd : urlSandbox;

    let json = await postJsonWithTimeout(startUrl, body, ENV.VERIFY_RECEIPT_TIMEOUT_MS, "verifyReceipt");
    if (json.status === 21007) json = await postJsonWithTimeout(urlSandbox, body, ENV.VERIFY_RECEIPT_TIMEOUT_MS, "verifyReceipt-sandbox");
    if (json.status === 21008) json = await postJsonWithTimeout(urlProd, body, ENV.VERIFY_RECEIPT_TIMEOUT_MS, "verifyReceipt-prod");

    // Non-success: surface diagnostics
    if (json.status !== 0) {
      return res.status(200).json({
        active: false,
        reason: "VERIFY_RECEIPT_ERROR",
        debug: {
          status: json.status,
          message: json.message || null,
          hasLatest: Array.isArray(json.latest_receipt_info),
          hasReceipt: Boolean(json.receipt),
          networkError: json.status === "NETWORK_ERROR" ? json.error : null,
          nonJson: json.status === "NON_JSON" ? json.raw : null
        }
      });
    }

    // Success: decide entitlement directly from receipt data
    const result = decideActiveFromVerifyReceipt(json, product_id);
    return res.json(result);
  } catch (e) {
    console.error("SERVER_ERROR", e);
    return res.status(500).json({ active: false, reason: "SERVER_ERROR", error: String(e?.message || e) });
  }
});

// ------------------------ Start ------------------------
app.listen(ENV.PORT, () => {
  console.log(`IAP server listening on port ${ENV.PORT} (${ENV.NODE_ENV})`);
});
