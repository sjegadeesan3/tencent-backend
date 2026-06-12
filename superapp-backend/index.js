// index.js — SuperApp Backend (Full Tencent Payment Flow)
require("dotenv").config();
const express = require("express");
const crypto  = require("crypto");
const https   = require("https");
const http    = require("http");
const { v4: uuidv4 } = require("uuid");

const { captureMiddleware } = require("./logger");
const dashboard             = require("./dashboard");
const serverDashboard       = require("./serverDashboard");

const app = express();
app.use((req, res, next) => { res.setHeader("ngrok-skip-browser-warning", "true"); next(); });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(captureMiddleware);
app.use(dashboard);
app.use("/serverDashboard", serverDashboard);
app.use((req, res, next) => {
  if (req.path === "/dashboard" || req.path.startsWith("/logs")) return next();
  console.log(`\n[SUPERAPP] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log("  Body:", JSON.stringify(req.body, null, 2));
  next();
});

// ── ENV ──────────────────────────────────────────────────────
const SECRET_KEY         = process.env.APP_ENCRYPT_KEY    || "0123456789abcdef0123456789abcdef";
const NOTIFY_SECRET      = process.env.NOTIFY_SECRET      || "superapp_miniapp_shared_secret_2026";
const MINIAPP_BACKEND_URL= process.env.MINIAPP_BACKEND_URL|| "https://tencentminiapptesting.xyz/miniapp";
const COFFEE_BACKEND_URL = process.env.COFFEE_BACKEND_URL || "https://tencentminiapptesting.xyz/coffee";
const TCSAS_OPENSERVER   = process.env.TCSAS_OPENSERVER   || "https://openapi-sg.tcmpp.com/openserver";

// ── Payment credentials (UOB as payment processor) ──────────
const fs = require('fs');
const MERCHANT_PRIVATE_KEY = (() => {
  const keyFile = process.env.MERCHANT_PRIVATE_KEY_FILE || '/root/merchant_private_key.pem';
  try { return fs.readFileSync(keyFile, 'utf8'); }
  catch { return process.env.MERCHANT_PRIVATE_KEY || ''; }
})();
const MERCHANT_CERT_SERIAL = process.env.MERCHANT_CERT_SERIAL || "65032F5287CAC43DA2D9273A14D15E4C97B43DAB";
const MERCHANT_ID          = process.env.MERCHANT_ID          || "STARBUCKS001";
const APIV3_KEY            = process.env.APIV3_KEY            || "UOBTmrwCoffeePayKey2026SGD12345";
const SUPERAPP_ID          = process.env.SUPERAPP_ID          || "app-zz8btbv1s4";

// ── Mini app routing ─────────────────────────────────────────
const MINIAPP_BACKEND_MAP = {
  "mpvc3tdaldpq7zpu": MINIAPP_BACKEND_URL,
  "mpapkxdfqzgbvj67": COFFEE_BACKEND_URL,
};
function getMiniAppBackendUrl(appid) {
  if (!appid) return MINIAPP_BACKEND_URL;
  return MINIAPP_BACKEND_MAP[appid] || MINIAPP_BACKEND_URL;
}

// ── Helpers ──────────────────────────────────────────────────
function verifyTCSignature(tcTimestamp, tcSignature) {
  try {
    const key     = Buffer.from(SECRET_KEY.substring(0, 32).padEnd(32, "0"), "utf8");
    const ts      = Buffer.from(tcTimestamp, "utf8");
    const padding = 16 - (ts.length % 16);
    const padded  = Buffer.concat([ts, Buffer.alloc(padding, padding)]);
    const cipher  = crypto.createCipheriv("aes-256-ecb", key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString("hex") === tcSignature;
  } catch { return false; }
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith("https") ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers
      }
    };
    const client = url.startsWith("https") ? https : http;
    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── paySign generation (for wx.requestPayment) ────────────────
function generatePaySign(appid, timestamp, nonceStr, prepayId) {
  const message = `${appid}\n${timestamp}\n${nonceStr}\n${prepayId}\n`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(message);
  const signed = sign.sign(MERCHANT_PRIVATE_KEY, "base64");
  return Buffer.from(signed, "base64").toString("base64");
}

// ── AES-256-GCM decrypt (for SAS payment callback, if SAS sends one to us) ───
function decryptAESGCM(ciphertext, nonce, associatedData) {
  const key        = Buffer.from(APIV3_KEY.padEnd(32, "0").substring(0, 32), "utf8");
  const cipherBuf  = Buffer.from(ciphertext, "base64");
  const authTag    = cipherBuf.slice(cipherBuf.length - 16);
  const encrypted  = cipherBuf.slice(0, cipherBuf.length - 16);
  const decipher   = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(associatedData || "", "utf8"));
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

// ── ok / fail helpers ─────────────────────────────────────────
const ok   = (data, res) => res.json({ code: 200, ...data, requestId: uuidv4() });
const fail = (code, msg, res) => res.json({ returnCode: code, returnMessage: msg, requestId: uuidv4() });

// ═══════════════════════════════════════════════════════════════
// STAGE 1: Pre-order — Superapp backend implements
// POST /v3/pay/transactions/jsapi
// SAS receives from MP backend, forwards here, we return prepayId
// ═══════════════════════════════════════════════════════════════
app.post("/v3/pay/transactions/jsapi", async (req, res) => {
  // mchid comes from Authorization header (not body per Tencent spec)
  const authHeader = req.headers["authorization"] || "";
  const mchidMatch = authHeader.match(/mchid="([^"]+)"/);
  const mchid = mchidMatch ? mchidMatch[1] : (req.body.mchid || MERCHANT_ID);
  const { appid, description, out_trade_no, notify_url, amount, payer, detail } = req.body;
  console.log(`  [/v3/pay/transactions/jsapi] order from SAS — appid=${appid} mchid=${mchid} out_trade_no=${out_trade_no}`);

  if (!appid || !mchid || !out_trade_no || !amount || !payer) {
    return res.status(400).json({ code: "PARAM_ERROR", message: "Missing required fields" });
  }

  // Generate prepay_id (UOB payment system)
  const prepay_id = `prepay_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;

  // Store order for later verification
  const orderStore = global.orderStore || (global.orderStore = {});
  orderStore[out_trade_no] = {
    prepay_id, appid, mchid, description, out_trade_no,
    notify_url, amount, payer, detail,
    status: "PENDING", created_at: Date.now(),
    _sasNotified: false,
  };

  console.log(`  [/v3/pay/transactions/jsapi] prepay_id=${prepay_id} ✅`);
  // SAS expects: returnCode, data.prepayId, requestId
  return res.json({
    returnCode:    "0",
    returnMessage: "success",
    data:          { prepayId: prepay_id },
    requestId:     uuidv4()
  });
});

// ═══════════════════════════════════════════════════════════════
// STAGE 2: Payment — validate able to pay
// POST /payment/validate
// Superapp client calls this after SDK forwards requestPayment
// ═══════════════════════════════════════════════════════════════
app.post("/payment/validate", async (req, res) => {
  const { prepay_id, appid, openid } = req.body;
  console.log(`  [/payment/validate] prepay_id=${prepay_id} appid=${appid}`);

  const orderStore = global.orderStore || {};
  const order = Object.values(orderStore).find(o => o.prepay_id === prepay_id);

  if (!order) {
    return res.json({ returnCode: "0", valid: false, message: "Order not found" });
  }

  // UOB banking validation — check user has sufficient balance
  // For POC: always valid
  console.log(`  [/payment/validate] order found — amount=${order.amount?.total} ${order.amount?.currency} ✅`);
  return res.json({
    returnCode: "0",
    valid: true,
    actualAmount: order.amount?.total || 0,
    currency: order.amount?.currency || "SGD",
    description: order.description,
    requestId: uuidv4()
  });
});

// ═══════════════════════════════════════════════════════════════
// STAGE 2: Payment — confirm payment
// POST /payment/confirm
// Called after user enters auth and confirms payment
// ═══════════════════════════════════════════════════════════════
app.post("/payment/confirm", async (req, res) => {
  const { prepay_id, appid, openid } = req.body;
  console.log(`  [/payment/confirm] prepay_id=${prepay_id} appid=${appid}`);

  const orderStore = global.orderStore || {};
  const order = Object.values(orderStore).find(o => o.prepay_id === prepay_id);

  if (!order) return res.json({ returnCode: "1001", returnMessage: "Order not found" });

  // Verify payment information (UOB banking side)
  // For POC: always success
  order.status      = "SUCCESS";
  order.paid_at     = Date.now();
  order.transaction_id = order.transaction_id || `txn_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  console.log(`  [/payment/confirm] payment verified ✅ transaction_id=${order.transaction_id}`);

  // ═══ SHIPMENT STEP 1: Superapp backend → SAS backend ═══════
  // Notify SAS payment result so portal status updates to Paid,
  // and SAS delivers async notification to MP backend.
  if (!order._sasNotified) {
    order._sasNotified = true;
    setImmediate(async () => {
      try {
        await notifySASPaymentResult(order);
      } catch (err) {
        console.error("  [/payment/confirm] SAS notification failed:", err.message);
      }
    });
  }

  return res.json({
    returnCode: "0",
    returnMessage: "Payment confirmed",
    transaction_id: order.transaction_id,
    out_trade_no: order.out_trade_no,
    requestId: uuidv4()
  });
});

// ═══════════════════════════════════════════════════════════════
// SHIPMENT STEP 1 — Superapp backend → SAS backend
// (Payment result notification)
//
// Confirmed by Tencent: SAS auto-injects a callback URL when it
// forwards the order-create request to our /v3/pay/transactions/jsapi.
// That URL (POC env) is:
//   https://apigateway-sg.tcmpp.com/payment/super-app/transactions/callback
//
// We POST event_type=TRANSACTION.SUCCESS with an AES-256-GCM
// encrypted `resource` (per section 2.2 of the Code Integration Guide).
// SAS then:
//   - marks the order as Paid in the TCSAS portal
//   - delivers the async notification to the MP backend (notify_payBack)
// ═══════════════════════════════════════════════════════════════
async function notifySASPaymentResult(order) {
  const url = "https://apigateway-sg.tcmpp.com/payment/super-app/transactions/callback";

  const amountTotal = (order.amount && order.amount.total) || 0;
  const currency    = (order.amount && order.amount.currency) || "SGD";
  const successTime = (() => {
    const d = new Date(Date.now() + 8 * 60 * 60 * 1000); // SGT (+08:00)
    return d.toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '');
  })();

  // AES-256-GCM encrypted resource — confirmed correct format by Tencent.
  // Requires APIv3 key (APIV3_KEY) to be registered for this merchant
  // in TCSAS portal (Standard Payment → Merchant Settings → STARBUCKS001).
  const innerData = {
    transaction_id:   order.transaction_id || ("txn_" + Date.now()),
    mch_id:           order.mchid || MERCHANT_ID,
    out_trade_no:     order.out_trade_no,
    appid:            order.appid,
    trade_state:      "SUCCESS",
    trade_state_desc: "Payment successful",
    trade_type:       "JSAPI",
    bank_type:        "OTHERS",
    success_time:     successTime,
    payer:            (order.payer && order.payer.openid) || "",
    attach:           "",
    amount: {
      total:          String(amountTotal),
      payer_total:    String(amountTotal),
      currency:       currency,
      payer_currency: currency,
    }
  };

  const apiKey = Buffer.from(APIV3_KEY.padEnd(32, "0").substring(0, 32), "utf8");
  const nonce  = crypto.randomBytes(12);
  const plaintext = JSON.stringify(innerData);
  const cipher = crypto.createCipheriv("aes-256-gcm", apiKey, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]).toString("base64");

  console.log(`  [notifySASPaymentResult] DEBUG innerData:`, plaintext);
  console.log(`  [notifySASPaymentResult] DEBUG ciphertext:`, ciphertext);
  console.log(`  [notifySASPaymentResult] DEBUG nonce:`, nonce.toString("base64"));
  console.log(`  [notifySASPaymentResult] DEBUG APIV3_KEY:`, APIV3_KEY);

  const bodyObj = {
    id:            uuidv4(),
    create_time:   successTime,
    event_type:    "TRANSACTION.SUCCESS",
    resource_type: "encrypt-resource",
    summary:       "pay success",
    out_trade_no:  order.out_trade_no,
    mchid:         order.mchid || MERCHANT_ID,
    mch_id:        order.mchid || MERCHANT_ID,
    appid:         order.appid,
    resource: {
      original_type:   "transaction",
      algorithm:       "AEAD_AES_256_GCM",
      ciphertext:      ciphertext,
      associated_data: "",
      nonce:           nonce.toString("base64"),
      out_trade_no:    order.out_trade_no,
      mchid:           order.mchid || MERCHANT_ID,
      mch_id:          order.mchid || MERCHANT_ID,
      appid:           order.appid,
    }
  };

  const bodyStr = JSON.stringify(bodyObj);

  // Section 2.2 (TC-Payment-Callback) headers — all required per Tencent.
  // Use ONE consistent timestamp (seconds) for both TC-Timestamp and TC-Signature.
  const tcTimestampSec = Math.floor(Date.now() / 1000).toString();

  // TC-Signature — AES-256-ECB over the seconds timestamp (consistent with TC-Timestamp header)
  const tcSig = (() => {
    const key     = Buffer.from(SECRET_KEY.substring(0, 32).padEnd(32, "0"), "utf8");
    const ts      = Buffer.from(tcTimestampSec, "utf8");
    const padding = 16 - (ts.length % 16);
    const padded  = Buffer.concat([ts, Buffer.alloc(padding, padding)]);
    const cipher  = crypto.createCipheriv("aes-256-ecb", key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString("hex");
  })();

  const callbackNonce = crypto.randomBytes(16).toString("hex").toUpperCase();

  // TC-Callback-Signature — APIv3 Certificate Signature (RSA-SHA256) of
  // timestamp\nnonce\nbody\n, signed with merchant private key (same
  // seconds timestamp as TC-Timestamp / TC-Signature above)
  const callbackSigMessage = `${tcTimestampSec}\n${callbackNonce}\n${bodyStr}\n`;
  const callbackSign = crypto.createSign("RSA-SHA256");
  callbackSign.update(callbackSigMessage);
  const tcCallbackSignature = callbackSign.sign(MERCHANT_PRIVATE_KEY, "base64");

  console.log(`  [notifySASPaymentResult] POST ${url}`);
  console.log(`  [notifySASPaymentResult] out_trade_no=${order.out_trade_no} trade_state=SUCCESS`);

  try {
    const curlHeaders = [
      `-H 'TC-Callback-Serial: ${MERCHANT_CERT_SERIAL}'`,
      `-H 'TC-Signature: ${tcSig}'`,
      `-H 'TC-Timestamp: ${tcTimestampSec}'`,
      `-H 'TC-Callback-Nonce: ${callbackNonce}'`,
      `-H 'TC-Callback-OutTradeNo: ${order.out_trade_no}'`,
      `-H 'TC-Callback-Signature: ${tcCallbackSignature}'`,
      `-H 'TC-ApplicationID: ${SUPERAPP_ID}'`,
      `-H 'TC-MerchantID: ${order.mchid || MERCHANT_ID}'`,
      `-H 'Content-Type: application/json'`,
    ].join(" \\\n  ");
    console.log(`  [notifySASPaymentResult] FULL CURL:\ncurl -X POST '${url}' \\\n  ${curlHeaders} \\\n  -d '${bodyStr}'`);

    const result = await httpPost(url, bodyObj, {
      "TC-Callback-Serial":     MERCHANT_CERT_SERIAL,
      "TC-Signature":           tcSig,
      "TC-Timestamp":           tcTimestampSec,
      "TC-Callback-Nonce":      callbackNonce,
      "TC-Callback-OutTradeNo": order.out_trade_no,
      "TC-Callback-Signature":  tcCallbackSignature,
      "TC-ApplicationID":       SUPERAPP_ID,
      "TC-MerchantID":          order.mchid || MERCHANT_ID,
    });
    console.log(`  [notifySASPaymentResult] SAS response:`, JSON.stringify(result));

    if (result && result.returnCode === "0") {
      console.log(`  [notifySASPaymentResult] SAS accepted — order should now show Paid ✅`);
    }
  } catch (err) {
    console.error(`  [notifySASPaymentResult] SAS call failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// STAGE 3: SAS → Superapp backend payment result notification
// (if SAS calls us — passthrough verification)
// POST /payment/notify
// Also called directly by Android MiniAppPaymentActivity after
// the user confirms payment.
// ═══════════════════════════════════════════════════════════════
app.post("/payment/notify", async (req, res) => {
  const tcTimestamp = req.headers["x-tc-timestamp"] || req.headers["tc-timestamp"] || "";
  const tcSignature = req.headers["x-tc-signature"] || req.headers["tc-signature"] || "";

  if (tcTimestamp && tcSignature) {
    if (!verifyTCSignature(tcTimestamp, tcSignature)) {
      console.error("  [/payment/notify] Invalid tc-signature — rejecting");
      return res.json({ returnCode: "1003", returnMessage: "Invalid signature", requestId: uuidv4() });
    }
    console.log("  [/payment/notify] tc-signature verified ✅ (SAS Passthrough call)");
  } else {
    console.log("  [/payment/notify] No tc-signature — direct Android call");
  }

  const { out_trade_no, prepay_id, openid, amount, status, appid } = req.body;
  if (!out_trade_no) return res.json({ returnCode: "1001", returnMessage: "Missing out_trade_no", requestId: uuidv4() });

  const event_type    = status === "FAILED" ? "TRANSACTION.FAIL" : "TRANSACTION.SUCCESS";
  const targetBackend = getMiniAppBackendUrl(appid);
  console.log(`  [/payment/notify] appid=${appid} routing to ${targetBackend}`);

  try {
    const payload   = `${out_trade_no}:${prepay_id}:${event_type}`;
    const signature = crypto.createHmac("sha256", NOTIFY_SECRET).update(payload).digest("hex");
    await httpPost(`${targetBackend}/notify_payBack`, {
      event_type, out_trade_no, prepay_id, appid, signature,
    });
    console.log(`  [/payment/notify] MP backend notified ✅`);
  } catch (err) {
    console.error("  [/payment/notify] MP backend notify failed:", err.message);
  }

  // ═══ SHIPMENT STEP 1: Superapp backend → SAS backend ═══════
  const orderStore = global.orderStore || {};
  const order = Object.values(orderStore).find(function(o) { return o.out_trade_no === out_trade_no; });
  if (order && !order._sasNotified) {
    order._sasNotified = true;
    order.status = "SUCCESS";
    order.transaction_id = order.transaction_id || ("txn_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex"));
    setImmediate(async function() {
      try {
        await notifySASPaymentResult(order);
      } catch (err) {
        console.error("  [/payment/notify] SAS callback failed:", err.message);
      }
    });
  }

  return res.json({ returnCode: "0", returnMessage: "ok", requestId: uuidv4() });
});

// ═══════════════════════════════════════════════════════════════
// STAGE 3: SAS → MP backend async retry — ACK endpoint
// POST /payment/notify/ack
// ═══════════════════════════════════════════════════════════════
app.post("/payment/notify/ack", async (req, res) => {
  console.log(`  [/payment/notify/ack] SAS ack received`);
  return res.json({ returnCode: "0", returnMessage: "ok", requestId: uuidv4() });
});

// ── Existing login endpoints ──────────────────────────────────
// POST /user/checkUser — per Code Integration Guide API spec (1.1):
//   Headers: TC-OpenId, TC-MiniAppID (context identifiers, signature-verified)
//   Body:    { userId: string }  — anonymized userId from the SDK
//   Returns: { returnCode, data: <boolean: does user exist>, requestId }
app.post("/user/checkUser", async (req, res) => {
  const tcTimestamp = req.headers["x-tc-timestamp"] || req.headers["tc-timestamp"] || "";
  const tcSignature = req.headers["x-tc-signature"] || req.headers["tc-signature"] || "";
  if (tcTimestamp && tcSignature && !verifyTCSignature(tcTimestamp, tcSignature)) {
    return res.json({ returnCode: "1003", returnMessage: "Invalid signature", requestId: uuidv4() });
  }

  const tcOpenId    = req.headers["tc-openid"]    || req.headers["TC-OpenId"]    || "";
  const tcMiniAppID = req.headers["tc-miniappid"] || req.headers["TC-MiniAppID"] || "";
  const { userId } = req.body;

  console.log(`  [checkUser] userId=${userId} TC-OpenId=${tcOpenId} TC-MiniAppID=${tcMiniAppID}`);

  if (!userId) {
    return res.json({ returnCode: "1004", returnMessage: "Missing userId", requestId: uuidv4() });
  }

  // PoC: every anonymized userId presented is considered an existing/registered user.
  const userExists = true;
  console.log(`  [checkUser] user exists=${userExists}`);
  return res.json({ returnCode: "0", data: userExists, requestId: uuidv4() });
});

// POST /user/getUserAvatar — spec 1.6, was missing entirely
app.post("/user/getUserAvatar", async (req, res) => {
  const { userId } = req.body;
  console.log(`  [getUserAvatar] userId=${userId}`);
  return res.json({ returnCode: "0", data: "https://picsum.photos/100", requestId: uuidv4() });
});

app.post("/user/getUserInfoTemporaryCode", async (req, res) => {
  const { type, userId } = req.body; // type: "email" | "phone"
  console.log(`  [getUserInfoTemporaryCode] type=${type} userId=${userId}`);
  const masked = type === "email" ? "mu****ng@tencent.com" : "158****2850";
  return res.json({ returnCode: "0", data: { data: masked, code: uuidv4() }, requestId: uuidv4() });
});
app.post("/user/getUserEmail", async (req, res) => {
  const { temporaryCode, userId } = req.body;
  console.log(`  [getUserEmail] userId=${userId} temporaryCode=${temporaryCode}`);
  return res.json({ returnCode: "0", data: "", requestId: uuidv4() });
});
app.post("/user/getUserPhoneNumber", async (req, res) => {
  const { temporaryCode, userId } = req.body;
  console.log(`  [getUserPhoneNumber] userId=${userId} temporaryCode=${temporaryCode}`);
  return res.json({ returnCode: "0", data: "", requestId: uuidv4() });
});
app.post("/user/getUserNick", async (req, res) => {
  return res.json({ returnCode: "0", data: { nick: "UOB User" }, requestId: uuidv4() });
});

app.get("/health", (req, res) => res.json({ status: "ok", service: "superapp-backend", version: "2.0.0-payment" }));

const PORT = process.env.SUPERAPP_PORT || 3001;
app.listen(PORT, () => console.log(`[SUPERAPP] listening on port ${PORT}`));