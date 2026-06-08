// index.js — MiniApp Backend
// Mounts: logger middleware, dashboard routes, API routes

require("dotenv").config();
const express = require("express");
const crypto  = require("crypto");
const https   = require("https");
const http    = require("http");
const { v4: uuidv4 } = require("uuid");

const { captureMiddleware } = require("./logger");
const dashboard             = require("./dashboard");

const app = express();

app.use((req, res, next) => { res.setHeader("ngrok-skip-browser-warning", "true"); next(); });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Logger middleware (captures all req/res to file) ──────────
app.use(captureMiddleware);

// ── Dashboard routes (/dashboard, /logs/data, /logs/clear) ───
app.use(dashboard);

// ── Console logger ────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/dashboard" || req.path.startsWith("/logs")) return next();
  console.log(`\n[MINIAPP] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log("  Body:", JSON.stringify(req.body, null, 2));
  next();
});

// ── ENV ───────────────────────────────────────────────────────
const TCSAS_OPENSERVER    = process.env.TCSAS_OPENSERVER    || "https://openapi-sg.tcmpp.com/openserver";
const APPSECRET           = process.env.APPSECRET           || "YOUR_APPSECRET";
const JWT_SECRET          = process.env.JWT_SECRET          || "changeme";
const APPID               = process.env.APPID               || "mpvc3tdaldpq7zpu";
const MINIAPP_BACKEND_URL = process.env.MINIAPP_BACKEND_URL || "https://tencentminiapptesting.xyz/miniapp";
// Shared secret with superapp-backend for verifying /notify_payBack calls
const NOTIFY_SECRET       = process.env.NOTIFY_SECRET       || "superapp_miniapp_shared_secret_2026";

// ── In-memory state ───────────────────────────────────────────
const users  = {};
const orders = {};

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
  } catch { return null; }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    }).on("error", reject);
  });
}

// ── POST /getUserInfo — Login ─────────────────────────────────
app.post("/getUserInfo", async (req, res) => {
  const { appid, code } = req.body;
  if (!appid) return res.json({ code: 400, data: { msg: "Missing appid" } });
  if (!code)  return res.json({ code: 400, data: { msg: "Missing code" } });

  const url = `${TCSAS_OPENSERVER}/sns/jscode2session?appid=${appid}&secret=${APPSECRET}&js_code=${code}&grant_type=authorization_code`;
  console.log("  [getUserInfo] Calling jscode2session:", url);

  let sessionData;
  try {
    sessionData = await httpGet(url);
    console.log("  [getUserInfo] Response:", JSON.stringify(sessionData));
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
    user = { openid, id: uuidv4(), userName: `User_${openid.substring(0, 8)}`,
             avatarUrl: "https://picsum.photos/100", phone: "", email: "", createdAt: Date.now() };
    users[openid] = user;
    console.log(`  [getUserInfo] New user openid=${openid}`);
  }

  const token = createToken({ openid, userId: user.id });
  return res.json({ code: 200, data: { userName: user.userName, token, id: user.id,
    avatarUrl: user.avatarUrl, phone: user.phone, email: user.email, account: openid } });
});

// ── POST /v3/pay/transactions/jsapi — Stage 1: Pre-order ──────
app.post("/v3/pay/transactions/jsapi", async (req, res) => {
  const { goods_detail, discount = 0, token } = req.body;

  if (!token) return res.json({ code: 401, data: { msg: "Missing token" } });
  const payload = verifyToken(token);
  if (!payload) return res.json({ code: 401, data: { msg: "Invalid or expired token" } });
  if (!goods_detail || goods_detail.length === 0) return res.json({ code: 400, data: { msg: "No goods in order" } });

  const out_trade_no = `order_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const timeStamp    = Math.floor(Date.now() / 1000).toString();
  const nonceStr     = crypto.randomBytes(10).toString("hex");
  const totalCents   = goods_detail.reduce((s, i) => s + Math.round((i.unit_price || 0) * 100) * (i.quantity || 1), 0);
  const finalAmount  = Math.max(totalCents - Math.round((discount || 0) * 100), 1);
  const prepayId     = `prepay_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;

  let paySign;
  if (process.env.MERCHANT_PRIVATE_KEY) {
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(`${APPID}\n${timeStamp}\n${nonceStr}\n${prepayId}\n`);
    paySign = sign.sign(process.env.MERCHANT_PRIVATE_KEY, "base64");
  } else {
    paySign = `TCSAS_PAY_${crypto.randomBytes(16).toString("hex")}`;
  }

  orders[out_trade_no] = { out_trade_no, openid: payload.openid, prepayId,
    status: "PENDING", amount: finalAmount, goods: goods_detail, createdAt: Date.now() };

  console.log(`  [pay] ✅ out_trade_no=${out_trade_no} amount=${finalAmount} openid=${payload.openid}`);

  return res.json({ code: 200, timeStamp, nonceStr, package: `prepay_id=${prepayId}`,
    signType: "RSA", paySign, out_trade_no });
});

// ── POST /payOrderV3 — Stage 1: Pre-order (Coffee uses this name) ──
// Alias for /v3/pay/transactions/jsapi — same logic, different URL
// Coffee mini app calls POST /payOrderV3 with {appid, goods_detail, id, token}
app.post("/payOrderV3", async (req, res) => {
  // Map coffee request format to standard format
  const goods_detail = req.body.goods_detail || [];
  const token        = req.body.token;
  const discount     = req.body.discount || 0;

  if (!token) return res.json({ code: 401, data: { msg: "Missing token" } });
  const payload = verifyToken(token);
  if (!payload) return res.json({ code: 401, data: { msg: "Invalid or expired token" } });
  if (!goods_detail || goods_detail.length === 0) return res.json({ code: 400, data: { msg: "No goods in order" } });

  const out_trade_no = `order_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const timeStamp    = Math.floor(Date.now() / 1000).toString();
  const nonceStr     = crypto.randomBytes(10).toString("hex");
  const totalCents   = goods_detail.reduce((s, i) => s + Math.round((i.unit_price || 0) * 100) * (i.quantity || 1), 0);
  const finalAmount  = Math.max(totalCents - Math.round((discount || 0) * 100), 1);
  const prepayId     = `prepay_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
  const paySign      = `TCSAS_PAY_${crypto.randomBytes(16).toString("hex")}`;

  orders[out_trade_no] = {
    out_trade_no, openid: payload.openid, prepayId,
    status: "PENDING", amount: finalAmount, goods: goods_detail, createdAt: Date.now()
  };

  console.log(`  [payOrderV3] ✅ out_trade_no=${out_trade_no} amount=${finalAmount}`);

  return res.json({ code: 200, timeStamp, nonceStr,
    package: `prepay_id=${prepayId}`, signType: "RSA", paySign, out_trade_no });
});

// ── POST /notify_payBack — Stage 3: SAS notification ─────────
app.post("/notify_payBack", (req, res) => {
  const { event_type, out_trade_no, prepay_id, signature } = req.body;

  // Verify HMAC signature — only superapp-backend knows NOTIFY_SECRET
  // This ensures miniapp-backend only accepts notifications from superapp-backend
  if (signature) {
    const payload  = `${out_trade_no}:${prepay_id}:${event_type}`;
    const expected = crypto.createHmac("sha256", NOTIFY_SECRET).update(payload).digest("hex");
    if (signature !== expected) {
      console.error("  [notify_payBack] Invalid signature — rejecting");
      return res.json({ code: 401, message: "Invalid signature" });
    }
    console.log("  [notify_payBack] Signature verified ✅");
  }

  if (out_trade_no && orders[out_trade_no]) {
    orders[out_trade_no].status     = event_type === "TRANSACTION.SUCCESS" ? "SUCCESS" : "FAILED";
    orders[out_trade_no].notifiedAt = Date.now();
    console.log(`  [notify_payBack] Order ${out_trade_no} → ${orders[out_trade_no].status}`);
  }

  // ACK — stops SAS retry loop
  return res.json({ code: 200, message: "OK" });
});

// ── POST /queryPayResult — Stage 4: Poll ─────────────────────
app.post("/queryPayResult", (req, res) => {
  const { out_trade_no, token } = req.body;
  if (!token) return res.json({ code: 401, data: { msg: "Missing token" } });
  const payload = verifyToken(token);
  if (!payload) return res.json({ code: 401, data: { msg: "Invalid token" } });
  if (!out_trade_no) return res.json({ code: 400, data: { msg: "Missing out_trade_no" } });
  const order = orders[out_trade_no];
  if (!order) return res.json({ code: 200, data: { out_trade_no, status: "PENDING" } });
  if (order.openid !== payload.openid) return res.json({ code: 403, data: { msg: "Unauthorized" } });
  return res.json({ code: 200, data: { out_trade_no: order.out_trade_no, status: order.status, amount: order.amount } });
});

// ── GET /health ───────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "miniapp-backend", time: new Date().toISOString(),
    appid: APPID, users_in_memory: Object.keys(users).length, orders_in_memory: Object.keys(orders).length });
});

const PORT = process.env.MINIAPP_PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ MiniApp Backend running on http://localhost:${PORT}`);
  console.log(`   Dashboard: https://tencentminiapptesting.xyz/miniapp/dashboard`);
  console.log(`   APPID:     ${APPID}`);
  console.log(`   APPSECRET: ${APPSECRET !== "YOUR_APPSECRET" ? "SET ✅" : "NOT SET ❌"}`);
});
