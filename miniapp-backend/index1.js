/**
 * ============================================================
 * MINI APP BACKEND SERVER
 * ============================================================
 * This is what the mini app's fetch.js calls directly.
 * Expose via ngrok, then set host in fetch.js.
 *
 * Also add this domain in:
 *   TCSAS Console → Application management → Configuration management → Request domain whitelist
 *
 * Endpoints called by the mini app:
 *   POST /getUserInfo    ← login: exchange wx.login code for user token
 *   POST /payOrderV3     ← payment: create order, get paySign for wx.requestPayment
 * ============================================================
 */

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const https = require("https");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Config ────────────────────────────────────────────────────
// Get APPSECRET from: TCSAS Console → Mini program management
//   → your mini app (mpvc3tdaldpq7zpu) → Development management → Key management
const TCSAS_OPENSERVER = process.env.TCSAS_OPENSERVER || "https://api-sg.tcmpp.com";
const APPSECRET = process.env.APPSECRET || "YOUR_APPSECRET_FROM_TCSAS_CONSOLE";
const JWT_SECRET = process.env.JWT_SECRET || "change_this_to_a_random_secret_string";

// ── Logging middleware ────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`\n[MINIAPP] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log("  Content-Type:", req.headers["content-type"]);
  console.log("  Body:", JSON.stringify(req.body, null, 2));
  next();
});

// ── In-memory user store (replace with real DB later) ─────────
// Key: openid  Value: user object
const users = {};

// ── Simple JWT implementation (no library needed) ─────────────
function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split(".");
    const expectedSig = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
    if (sig !== expectedSig) throw new Error("Invalid signature");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp < Date.now()) throw new Error("Token expired");
    return payload;
  } catch (e) {
    return null;
  }
}

// ── Helper: HTTP GET request ──────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    }).on("error", reject);
  });
}

// ============================================================
// POST /getUserInfo
// Called by mini app fetch.js loginFromServer()
// Body: { appid: "mpvc3tdaldpq7zpu", code: "<one_time_code_from_wx.login>" }
//
// Flow:
//   1. Call TCSAS jscode2session with appid + appsecret + code
//   2. Get openid + session_key back
//   3. Create/fetch user in DB
//   4. Return { code: 200, data: { userName, token, ... } }
// ============================================================
app.post("/getUserInfo", async (req, res) => {
  console.log("  Raw body keys:", Object.keys(req.body || {}));
  const { appid, code } = req.body;

  if (!appid || !code) {
    console.log("  ERROR: appid=", appid, "code=", code);
    return res.json({ code: 400, data: { msg: `Missing appid or code. Received: ${JSON.stringify(req.body)}` } });
  }

  console.log(`  [getUserInfo] appid=${appid} code=${code}`);

  // Step 1: Exchange code for openid via TCSAS jscode2session
  const jscode2sessionUrl =
    `${TCSAS_OPENSERVER}/sns/jscode2session` +
    `?appid=${appid}` +
    `&secret=${APPSECRET}` +
    `&js_code=${code}` +
    `&grant_type=authorization_code`;

  let sessionData;
  try {
    sessionData = await httpGet(jscode2sessionUrl);
    console.log(`  [getUserInfo] jscode2session response:`, sessionData);
  } catch (err) {
    console.error(`  [getUserInfo] jscode2session call failed:`, err.message);
    return res.json({ code: 500, data: { msg: "Failed to contact TCSAS OpenServer" } });
  }

  // Handle TCSAS error response
  if (sessionData.errcode && sessionData.errcode !== 0) {
    console.error(`  [getUserInfo] TCSAS error: ${sessionData.errcode} ${sessionData.errmsg}`);
    return res.json({
      code: 401,
      data: { msg: `TCSAS error: ${sessionData.errmsg || "invalid code"}` },
    });
  }

  const { openid, session_key } = sessionData;

  if (!openid) {
    console.error(`  [getUserInfo] No openid returned. Full response:`, sessionData);
    return res.json({ code: 401, data: { msg: "Invalid code - no openid returned" } });
  }

  // Step 2: Create or fetch user by openid
  let user = users[openid];
  if (!user) {
    user = {
      openid,
      id: uuidv4(),
      userName: `User_${openid.substring(0, 8)}`,
      avatarUrl: "https://picsum.photos/100",
      phone: "",
      email: "",
      createdAt: Date.now(),
    };
    users[openid] = user;
    console.log(`  [getUserInfo] New user created: openid=${openid}`);
  } else {
    console.log(`  [getUserInfo] Existing user: openid=${openid}`);
  }

  // Step 3: Generate session token (JWT)
  // NOTE: Never store session_key client-side — keep it server-side only
  const token = createToken({ openid, userId: user.id });

  // Step 4: Return to mini app
  // This maps exactly to what fetch.js loginFromServer() expects:
  //   success?.(res?.data.data)
  // And what login() stores:
  //   wx.setStorageSync(USER_NAME, userInfo.userName)
  //   wx.setStorageSync(USER_INFO, userInfo)
  return res.json({
    code: 200,
    data: {
      userName: user.userName,
      token,
      id: user.id,
      avatarUrl: user.avatarUrl,
      phone: user.phone,
      email: user.email,
      account: openid,
    },
  });
});

// ============================================================
// POST /payOrderV3
// Called by mini app fetch.js commonPay()
// Body: {
//   appid,
//   goods_detail: [{ merchant_goods_id, goods_name, quantity, unit_price }],
//   discount,
//   token
// }
//
// Flow:
//   1. Verify token
//   2. Calculate total amount from goods_detail
//   3. Call superapp backend /v3/pay/transactions/jsapi (via TCSAS)
//   4. Get prepay_id back
//   5. Generate paySign with RSA-SHA256
//   6. Return payment params for wx.requestPayment
// ============================================================
app.post("/payOrderV3", async (req, res) => {
  const { appid, goods_detail, discount = 0, token } = req.body;

  if (!token) {
    return res.json({ code: 401, data: { msg: "Missing token" } });
  }

  // Step 1: Verify token
  const payload = verifyToken(token);
  if (!payload) {
    return res.json({ code: 401, data: { msg: "Invalid or expired token" } });
  }

  const user = users[payload.openid];
  if (!user) {
    return res.json({ code: 401, data: { msg: "User not found" } });
  }

  console.log(`  [payOrderV3] openid=${payload.openid} goods=${goods_detail?.length} items`);

  if (!goods_detail || goods_detail.length === 0) {
    return res.json({ code: 400, data: { msg: "No goods in order" } });
  }

  // Step 2: Calculate total (unit_price is already in dollars from fetch.js, convert to cents)
  const totalCents = Math.round(
    goods_detail.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) * 100
  );
  const discountCents = Math.round(discount * 100);
  const finalCents = Math.max(totalCents - discountCents, 1);

  const outTradeNo = `order_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const timeExpire = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "+08:00");

  console.log(`  [payOrderV3] out_trade_no=${outTradeNo} total=${finalCents} cents`);

  // Step 3: In production, call TCSAS /v3/pay/transactions/jsapi here
  // TCSAS will forward it to your superapp backend /v3/pay/transactions/jsapi
  // For now, we simulate the prepay_id response since payment console setup is pending

  // TODO: Replace this block with real TCSAS payment API call when payment is enabled
  // const prepayId = await callTCSASPaymentAPI({ appid, outTradeNo, totalCents, openid: payload.openid });
  const prepayId = `prepay_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
  console.log(`  [payOrderV3] prepay_id=${prepayId} (simulated)`);

  // Step 4: Generate paySign
  // Formula from docs: appId\ntimeStamp\nnonceStr\nprepayId\n  signed with merchant private key RSA-SHA256
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(10).toString("hex");
  const packageStr = `prepay_id=${prepayId}`;

  // NOTE: In production, use your real RSA private key from TCSAS console
  // For development, we return a mock paySign
  // When you have the real private key:
  //   const privateKey = fs.readFileSync('./merchant_private_key.pem');
  //   const string2sign = `${appid}\n${timeStamp}\n${nonceStr}\n${prepayId}\n`;
  //   const sign = crypto.createSign('RSA-SHA256');
  //   sign.update(string2sign);
  //   paySign = sign.sign(privateKey, 'base64');
  const paySign = `MOCK_PAY_SIGN_${crypto.randomBytes(8).toString("hex")}`;

  // Step 5: Return payment params to mini app
  // This maps exactly to what order-confirm/index.js expects from commonPay success:
  //   wx.requestPayment({ ...payInfo, success, fail })
  return res.json({
    code: 200,
    timeStamp,
    nonceStr,
    package: packageStr,
    signType: "RSA",
    paySign,
  });
});

// ── Health check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "miniapp-backend", time: new Date().toISOString() });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.MINIAPP_PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ MiniApp Backend running on http://localhost:${PORT}`);
  console.log(`   Expose via ngrok: ngrok http ${PORT}`);
  console.log(`   Then update fetch.js: const host = "https://YOUR_NGROK_URL"`);
  console.log(`   And whitelist in TCSAS Console → Request domain whitelist`);
});
