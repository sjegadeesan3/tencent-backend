// ─────────────────────────────────────────────────────────────────────────────
// miniapp-backend/index.js  — TCSAS Payment Integration
//
// HOW THE PAYMENT FLOW ACTUALLY WORKS (from the sequence diagram):
//
// Stage 1 — Pre-order generation
//   Mini program  →  POST /payOrderV3  →  miniapp-backend
//   miniapp-backend generates its own prepayId + out_trade_no
//   miniapp-backend signs it with RSA key → returns paySign to mini program
//   (miniapp-backend does NOT call SAS here — SAS is NOT involved in pre-order)
//
// Stage 2 — Payment (SDK handles this, not our code)
//   Mini program calls wx.requestPayment({timeStamp, nonceStr, package, signType, paySign})
//   → TCSAS SDK intercepts it (this is TCSAS SDK, NOT WeChat)
//   → SDK sends to SAS: "validate able to pay"
//   → SAS validates → calls superapp-backend POST /v3/pay/transactions/jsapi
//   → SDK pops up payment authorization page on super app client (Android)
//   → MiniOpenApiProxyImpl.requestPayment() handles it
//   → User confirms → SDK returns success/fail to mini program
//
// Stage 3 — Shipment notification (SAS calls miniapp-backend async)
//   After payment: SAS  →  POST /notify_payBack  →  miniapp-backend
//   miniapp-backend must return { code: 200 } to ACK and stop SAS retries (24h)
//
// Stage 4 — Payment result confirmation (optional polling)
//   Mini program  →  POST /queryPayResult  →  miniapp-backend
//   Returns order status so pay-result page can show confirmed result
//
// KEY INSIGHT: TCSAS SDK intercepts wx.requestPayment() and routes it through
// the super app (Android MiniOpenApiProxyImpl.requestPayment). The SDK does NOT
// independently validate paySign format. Since we don't have merchant RSA keys
// yet, we generate a placeholder paySign — the SDK passes it to Android and
// Android's requestPayment() returns success immediately (our current impl).
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express = require("express");
const crypto  = require("crypto");
const https   = require("https");
const http    = require("http");
const { v4: uuidv4 } = require("uuid");

const app = express();

app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── ENV ───────────────────────────────────────────────────────
const TCSAS_OPENSERVER    = process.env.TCSAS_OPENSERVER    || "https://openapi-sg.tcmpp.com/openserver";
const APPSECRET           = process.env.APPSECRET           || "YOUR_APPSECRET";
const JWT_SECRET          = process.env.JWT_SECRET          || "changeme";
const APPID               = process.env.APPID               || "mpvc3tdaldpq7zpu";
const MINIAPP_BACKEND_URL = process.env.MINIAPP_BACKEND_URL || "https://tencentminiapptesting.xyz/miniapp";

// ── Logging ───────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`\n[MINIAPP] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log("  Body:", JSON.stringify(req.body, null, 2));
  next();
});

// ── In-memory users & orders ──────────────────────────────────
const users  = {};   // keyed by openid
const orders = {};   // keyed by out_trade_no

// ── JWT helpers ───────────────────────────────────────────────
function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body   = Buffer.from(
    JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
    if (sig !== expected) throw new Error("bad sig");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp < Date.now()) throw new Error("expired");
    return payload;
  } catch {
    return null;
  }
}

// ── HTTP GET helper (for jscode2session) ─────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    }).on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────
// POST /getUserInfo  — Login (unchanged, working correctly)
// ─────────────────────────────────────────────────────────────
app.post("/getUserInfo", async (req, res) => {
  const { appid, code } = req.body;
  if (!appid) return res.json({ code: 400, data: { msg: "Missing appid" } });
  if (!code)  return res.json({ code: 400, data: { msg: "Missing code" } });

  const url =
    `${TCSAS_OPENSERVER}/sns/jscode2session` +
    `?appid=${appid}&secret=${APPSECRET}&js_code=${code}&grant_type=authorization_code`;

  console.log("  [getUserInfo] Calling jscode2session:", url);

  let sessionData;
  try {
    sessionData = await httpGet(url);
    console.log("  [getUserInfo] jscode2session response:", JSON.stringify(sessionData));
  } catch (err) {
    return res.json({ code: 500, data: { msg: "Failed to contact TCSAS: " + err.message } });
  }

  if (sessionData.errcode && sessionData.errcode !== 0) {
    return res.json({ code: 401, data: { msg: `TCSAS error ${sessionData.errcode}: ${sessionData.errmsg}` } });
  }

  const { openid } = sessionData;
  if (!openid) return res.json({ code: 401, data: { msg: "No openid returned" } });

  let user = users[openid];
  if (!user) {
    user = {
      openid,
      id:        uuidv4(),
      userName:  `User_${openid.substring(0, 8)}`,
      avatarUrl: "https://picsum.photos/100",
      phone:     "",
      email:     "",
      createdAt: Date.now(),
    };
    users[openid] = user;
    console.log(`  [getUserInfo] New user created openid=${openid}`);
  } else {
    console.log(`  [getUserInfo] Existing user openid=${openid}`);
  }

  const token = createToken({ openid, userId: user.id });
  return res.json({
    code: 200,
    data: { userName: user.userName, token, id: user.id, avatarUrl: user.avatarUrl,
            phone: user.phone, email: user.email, account: openid },
  });
});

// ─────────────────────────────────────────────────────────────
// POST /v3/pay/transactions/jsapi  — Stage 1: Pre-order generation
//
// Called by: Mini program frontend (via commonPay() in fetch.js)
//
// What this does:
//   1. Validates JWT token
//   2. Generates out_trade_no + prepayId (miniapp-backend owns these)
//   3. Generates paySign (RSA-SHA256 with merchant private key, or
//      a placeholder string until merchant keys are obtained)
//   4. Saves order state for later notification/polling
//   5. Returns payment params to mini program for wx.requestPayment()
//
// NOTE: miniapp-backend does NOT call SAS here.
// The SAS is involved only AFTER wx.requestPayment() fires from
// the mini program — the TCSAS SDK routes it through the super app
// which calls superapp-backend /v3/pay/transactions/jsapi.
// ─────────────────────────────────────────────────────────────
app.post("/v3/pay/transactions/jsapi", async (req, res) => {
  const { goods_detail, discount = 0, token, appid } = req.body;

  // 1. Validate JWT
  if (!token) {
    return res.json({ code: 401, data: { msg: "Missing token — please login first" } });
  }
  const payload = verifyToken(token);
  if (!payload) {
    return res.json({ code: 401, data: { msg: "Invalid or expired token" } });
  }
  const user = users[payload.openid];
  if (!user) {
    return res.json({ code: 401, data: { msg: "User not found" } });
  }
  if (!goods_detail || goods_detail.length === 0) {
    return res.json({ code: 400, data: { msg: "No goods in order" } });
  }

  // 2. Generate order identifiers
  const out_trade_no = `order_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const timeStamp    = Math.floor(Date.now() / 1000).toString();
  const nonceStr     = crypto.randomBytes(10).toString("hex");

  // Calculate total amount in cents
  const totalCents    = goods_detail.reduce((sum, item) =>
    sum + Math.round((item.unit_price || 0) * 100) * (item.quantity || 1), 0);
  const discountCents = Math.round((discount || 0) * 100);
  const finalAmount   = Math.max(totalCents - discountCents, 1);

  console.log(`  [payOrderV3] out_trade_no=${out_trade_no} amount=${finalAmount} openid=${payload.openid}`);

  // 3. Generate prepayId (miniapp-backend owns this)
  const prepayId = `prepay_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;

  // 4. Generate paySign
  // Per TCSAS docs: sign string = appId\ntimeStamp\nnonceStr\nprepayId\n
  // Signed with merchant RSA private key.
  //
  // CURRENT STATE: No merchant RSA key yet (requires TCSAS merchant onboarding).
  // The TCSAS SDK passes wx.requestPayment() params directly to
  // MiniOpenApiProxyImpl.requestPayment() in Android — the SDK does NOT
  // independently validate the paySign format. Our Android code returns
  // success immediately, so this placeholder works for now.
  //
  // WHEN YOU HAVE MERCHANT KEYS: set MERCHANT_PRIVATE_KEY in .env and
  // uncomment the real signing code below.
  let paySign;
  const MERCHANT_PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY;
  if (MERCHANT_PRIVATE_KEY) {
    // Real RSA signing (use when merchant keys obtained from TCSAS console)
    const string2sign = `${APPID}\n${timeStamp}\n${nonceStr}\n${prepayId}\n`;
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(string2sign);
    paySign = sign.sign(MERCHANT_PRIVATE_KEY, "base64");
    console.log(`  [paySign] ✅ Real RSA paySign generated`);
  } else {
    // Placeholder — works because TCSAS SDK delegates to Android MiniOpenApiProxyImpl
    paySign = `TCSAS_PAY_${crypto.randomBytes(16).toString("hex")}`;
    console.log(`  [paySign] ℹ️  Placeholder paySign (MERCHANT_PRIVATE_KEY not set — Android handles it)`);
  }

  // 5. Save order state
  orders[out_trade_no] = {
    out_trade_no,
    openid:    payload.openid,
    prepayId,
    status:    "PENDING",   // PENDING | SUCCESS | FAILED
    amount:    finalAmount,
    goods:     goods_detail,
    createdAt: Date.now(),
  };

  console.log(`  [payOrderV3] ✅ Order created prepayId=${prepayId}`);

  // 6. Return payment params to mini program
  // Mini program passes these to wx.requestPayment()
  // TCSAS SDK intercepts wx.requestPayment() and calls
  // MiniOpenApiProxyImpl.requestPayment() in the Android super app
  return res.json({
    code:      200,
    timeStamp,
    nonceStr,
    package:   `prepay_id=${prepayId}`,
    signType:  "RSA",
    paySign,
    out_trade_no,   // returned so pay-result page can poll
  });
});

// ─────────────────────────────────────────────────────────────
// POST /notify_payBack  — Stage 3: Shipment/delivery notification
//
// Called by: SAS backend (asynchronously, after payment completes)
// SAS retries this for 24 hours until it gets { code: 200 } ACK.
// ─────────────────────────────────────────────────────────────
app.post("/notify_payBack", (req, res) => {
  console.log("  [notify_payBack] ✅ Payment notification received from SAS");
  console.log("  [notify_payBack] Body:", JSON.stringify(req.body, null, 2));

  // SAS sends: { event_type, resource: { ciphertext, ... }, out_trade_no }
  const { event_type, out_trade_no } = req.body;

  if (out_trade_no && orders[out_trade_no]) {
    orders[out_trade_no].status      = event_type === "TRANSACTION.SUCCESS" ? "SUCCESS" : "FAILED";
    orders[out_trade_no].notifiedAt  = Date.now();
    console.log(`  [notify_payBack] Order ${out_trade_no} → status=${orders[out_trade_no].status}`);
  }

  // CRITICAL: ACK to stop SAS retries
  return res.json({ code: 200, message: "OK" });
});

// ─────────────────────────────────────────────────────────────
// POST /queryPayResult  — Stage 4: Optional polling
//
// Called by: Mini program pay-result page
// ─────────────────────────────────────────────────────────────
app.post("/queryPayResult", (req, res) => {
  const { out_trade_no, token } = req.body;

  if (!token) return res.json({ code: 401, data: { msg: "Missing token" } });
  const payload = verifyToken(token);
  if (!payload) return res.json({ code: 401, data: { msg: "Invalid token" } });
  if (!out_trade_no) return res.json({ code: 400, data: { msg: "Missing out_trade_no" } });

  const order = orders[out_trade_no];
  if (!order) {
    // Order not found — wx.requestPayment() may have succeeded but
    // SAS notification hasn't arrived yet. Return PENDING.
    return res.json({ code: 200, data: { out_trade_no, status: "PENDING" } });
  }

  if (order.openid !== payload.openid) {
    return res.json({ code: 403, data: { msg: "Unauthorized" } });
  }

  console.log(`  [queryPayResult] ${out_trade_no} → ${order.status}`);
  return res.json({
    code: 200,
    data: { out_trade_no: order.out_trade_no, status: order.status, amount: order.amount },
  });
});

// ── Health ────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:            "ok",
    server:            "miniapp-backend",
    time:              new Date().toISOString(),
    appsecret_set:     APPSECRET !== "YOUR_APPSECRET",
    appid:             APPID,
    merchant_key_set:  !!process.env.MERCHANT_PRIVATE_KEY,
    users_in_memory:   Object.keys(users).length,
    orders_in_memory:  Object.keys(orders).length,
  });
});

const PORT = process.env.MINIAPP_PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ MiniApp Backend running on http://localhost:${PORT}`);
  console.log(`   TCSAS_OPENSERVER:    ${TCSAS_OPENSERVER}`);
  console.log(`   APPID:               ${APPID}`);
  console.log(`   APPSECRET set:       ${APPSECRET !== "YOUR_APPSECRET" ? "YES ✅" : "NO ❌"}`);
  console.log(`   MERCHANT_PRIVATE_KEY: ${process.env.MERCHANT_PRIVATE_KEY ? "YES ✅" : "NO — placeholder paySign (OK for now)"}`);
  console.log(`   MINIAPP_BACKEND_URL: ${MINIAPP_BACKEND_URL}`);
  console.log(`\n   Endpoints:`);
  console.log(`   POST /getUserInfo                 — login`);
  console.log(`   POST /v3/pay/transactions/jsapi   — Stage 1: create order`);
  console.log(`   POST /notify_payBack              — Stage 3: SAS payment notification`);
  console.log(`   POST /queryPayResult              — Stage 4: poll payment status`);
  console.log(`   GET  /health                      — health check`);
});
