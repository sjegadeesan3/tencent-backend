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

const TCSAS_OPENSERVER    = process.env.TCSAS_OPENSERVER    || "https://openapi-sg.tcmpp.com/openserver";
const APPSECRET           = process.env.APPSECRET           || "YOUR_APPSECRET";
const JWT_SECRET          = process.env.JWT_SECRET          || "changeme";
const APPID               = process.env.APPID               || "mpvc3tdaldpq7zpu";
const MINIAPP_BACKEND_URL = process.env.MINIAPP_BACKEND_URL || "https://tencentminiapptesting.xyz/miniapp";

app.use((req, res, next) => {
  console.log(`\n[MINIAPP] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log("  Body:", JSON.stringify(req.body, null, 2));
  next();
});

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
  } catch {
    return null;
  }
}

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

// ── POST /getUserInfo — Login ─────────────────────────────────
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

// ── POST /v3/pay/transactions/jsapi — Stage 1: Pre-order ──────
// FIX: Removed users[payload.openid] lookup — JWT token is
// sufficient proof of identity. users{} is in-memory so it
// resets on pm2 restart, but the JWT token stays valid for 7 days
// in the mini program. No need to look up the user object for payment.
app.post("/v3/pay/transactions/jsapi", async (req, res) => {
  const { goods_detail, discount = 0, token, appid } = req.body;

  // Validate JWT — this is the only auth check needed
  if (!token) {
    return res.json({ code: 401, data: { msg: "Missing token — please login first" } });
  }
  const payload = verifyToken(token);
  if (!payload) {
    return res.json({ code: 401, data: { msg: "Invalid or expired token" } });
  }
  // NOTE: No users[payload.openid] check — JWT already proves identity.
  // The openid is embedded in the token. No user object needed for payment.

  if (!goods_detail || goods_detail.length === 0) {
    return res.json({ code: 400, data: { msg: "No goods in order" } });
  }

  const out_trade_no = `order_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const timeStamp    = Math.floor(Date.now() / 1000).toString();
  const nonceStr     = crypto.randomBytes(10).toString("hex");

  const totalCents    = goods_detail.reduce((sum, item) =>
    sum + Math.round((item.unit_price || 0) * 100) * (item.quantity || 1), 0);
  const discountCents = Math.round((discount || 0) * 100);
  const finalAmount   = Math.max(totalCents - discountCents, 1);

  const prepayId = `prepay_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;

  let paySign;
  const MERCHANT_PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY;
  if (MERCHANT_PRIVATE_KEY) {
    const string2sign = `${APPID}\n${timeStamp}\n${nonceStr}\n${prepayId}\n`;
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(string2sign);
    paySign = sign.sign(MERCHANT_PRIVATE_KEY, "base64");
    console.log(`  [paySign] ✅ Real RSA paySign generated`);
  } else {
    paySign = `TCSAS_PAY_${crypto.randomBytes(16).toString("hex")}`;
    console.log(`  [paySign] ℹ️  Placeholder paySign (Android handles it)`);
  }

  orders[out_trade_no] = {
    out_trade_no,
    openid:    payload.openid,
    prepayId,
    status:    "PENDING",
    amount:    finalAmount,
    goods:     goods_detail,
    createdAt: Date.now(),
  };

  console.log(`  [payOrderV3] ✅ out_trade_no=${out_trade_no} amount=${finalAmount} openid=${payload.openid}`);

  return res.json({
    code:      200,
    timeStamp,
    nonceStr,
    package:   `prepay_id=${prepayId}`,
    signType:  "RSA",
    paySign,
    out_trade_no,
  });
});

// ── POST /notify_payBack — Stage 3: SAS notification ─────────
app.post("/notify_payBack", (req, res) => {
  console.log("  [notify_payBack] ✅ Received from SAS");
  console.log("  [notify_payBack] Body:", JSON.stringify(req.body, null, 2));

  const { event_type, out_trade_no } = req.body;
  if (out_trade_no && orders[out_trade_no]) {
    orders[out_trade_no].status     = event_type === "TRANSACTION.SUCCESS" ? "SUCCESS" : "FAILED";
    orders[out_trade_no].notifiedAt = Date.now();
    console.log(`  [notify_payBack] Order ${out_trade_no} → ${orders[out_trade_no].status}`);
  }

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
  if (!order) {
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

// ── GET /health ───────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:           "ok",
    server:           "miniapp-backend",
    time:             new Date().toISOString(),
    appsecret_set:    APPSECRET !== "YOUR_APPSECRET",
    appid:            APPID,
    merchant_key_set: !!process.env.MERCHANT_PRIVATE_KEY,
    users_in_memory:  Object.keys(users).length,
    orders_in_memory: Object.keys(orders).length,
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
  console.log(`   POST /notify_payBack              — Stage 3: SAS notification`);
  console.log(`   POST /queryPayResult              — Stage 4: poll status`);
  console.log(`   GET  /health                      — health check`);
});