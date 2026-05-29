// ============================================================
// superapp-backend/index.js  — TCSAS Payment Integration
//
// NEW in this version:
//   POST /payment/notify  — After user completes payment in the
//                           super app UI, this notifies SAS that
//                           payment is confirmed.
//   POST /payment/callback — SAS calls this to deliver payment
//                            result notification to super app.
// ============================================================

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

// ── ENV config ────────────────────────────────────────────────
// Required in .env:
//   APP_ENCRYPT_KEY=0123456789abcdef0123456789abcdef  (32 chars, must match TCSAS console)
//   TCSAS_OPENSERVER=https://api-sg.tcmpp.com
//   SUPERAPP_PORT=3001
const SECRET_KEY      = process.env.APP_ENCRYPT_KEY  || "0123456789abcdef0123456789abcdef";
const TCSAS_OPENSERVER = process.env.TCSAS_OPENSERVER || "https://api-sg.tcmpp.com";

// ── TC-Signature verification (AES-ECB) ──────────────────────
// TCSAS signs: AES-ECB-encrypt(timestamp, secretKey) → hex
// We verify by generating the same and comparing
function verifyTCSignature(tcTimestamp, tcSignature) {
  try {
    const key     = Buffer.from(SECRET_KEY.substring(0, 32).padEnd(32, "0"), "utf8");
    const ts      = Buffer.from(tcTimestamp, "utf8");
    const blockSize = 16;
    const padding   = blockSize - (ts.length % blockSize);
    const padded    = Buffer.concat([ts, Buffer.alloc(padding, padding)]);
    const cipher    = crypto.createCipheriv("aes-256-ecb", key, null);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    const expected  = encrypted.toString("hex");
    console.log(`  [verify] expected=${expected} received=${tcSignature}`);
    return expected === tcSignature;
  } catch (e) {
    console.error("  [verify] signature error:", e.message);
    return false;
  }
}

// ── HTTP POST helper ──────────────────────────────────────────
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (url.startsWith("https") ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const client = url.startsWith("https") ? https : http;
    const req    = client.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Logging ───────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`\n[SUPERAPP] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log("  Headers:", JSON.stringify(req.headers, null, 2));
  console.log("  Body:",    JSON.stringify(req.body,    null, 2));
  next();
});

// ── In-memory state ───────────────────────────────────────────
const users = {
  mock_user_001: {
    userId:    "mock_user_001",
    nickName:  "Test User",
    avatarUrl: "https://picsum.photos/100",
    phone:     "+6512345678",
    email:     "testuser@example.com",
    exists:    true,
  },
};

const tempCodes    = {};
const paymentLogs  = [];   // keep last 100 payment events for debugging

function generateTempCode(userId, type) {
  const code = crypto.randomBytes(16).toString("hex");
  tempCodes[code] = { userId, type, createdAt: Date.now() };
  setTimeout(() => delete tempCodes[code], 5 * 60 * 1000);
  return code;
}

function successResp(data, res) {
  return res.json({ returnCode: "0", returnMessage: "ok", data, requestId: uuidv4() });
}

function errorResp(code, message, res) {
  return res.json({ returnCode: code, returnMessage: message, requestId: uuidv4() });
}

// ──────────────────────────────────────────────────────────────
// LOGIN ENDPOINTS (unchanged)
// ──────────────────────────────────────────────────────────────

// POST /user/checkUser  (called by TCSAS OpenServer during wx.login)
app.post("/user/checkUser", (req, res) => {
  const tcTimestamp = req.headers["tc-timestamp"];
  const tcSignature = req.headers["tc-signature"];

  if (tcTimestamp && tcSignature) {
    const valid = verifyTCSignature(tcTimestamp, tcSignature);
    console.log(`  [checkUser] Signature valid: ${valid}`);
  }

  const { userId } = req.body;
  console.log(`  [checkUser] userId=${userId}`);
  if (!userId) return errorResp("1001", "userId is required", res);

  if (!users[userId]) {
    users[userId] = {
      userId,
      nickName:  `User_${userId.substring(0, 6)}`,
      avatarUrl: "https://picsum.photos/100",
      phone:     "",
      email:     "",
      exists:    true,
    };
    console.log(`  [checkUser] Auto-created user: ${userId}`);
  }

  return successResp(true, res);
});

// POST /checkUser  (alternate path)
app.post("/checkUser", (req, res) => {
  const { userId } = req.body;
  if (!userId) return errorResp("1001", "userId is required", res);
  if (!users[userId]) {
    users[userId] = {
      userId,
      nickName:  `User_${userId.substring(0, 6)}`,
      avatarUrl: "https://picsum.photos/100",
      phone:     "",
      email:     "",
      exists:    true,
    };
  }
  return successResp(true, res);
});

app.post("/user/getUserInfoTemporaryCode", (req, res) => {
  const { userId, type } = req.body;
  if (!userId || !type) return errorResp("1001", "userId and type required", res);
  const user = users[userId];
  if (!user) return errorResp("1002", "User not found", res);
  const code = generateTempCode(userId, type);
  let maskedData = "";
  if (type === "phone") {
    maskedData = (user.phone || "+6512345678").replace(/(\+\d{2})(\d+)(\d{2})$/, "$1****$3");
  } else if (type === "email") {
    const [local, domain] = (user.email || "user@example.com").split("@");
    maskedData = `${local.substring(0, 2)}****@${domain}`;
  }
  return successResp({ data: maskedData, code }, res);
});

app.post("/user/getUserEmail", (req, res) => {
  const { temporaryCode, userId } = req.body;
  const tempData = tempCodes[temporaryCode];
  if (!tempData || tempData.type !== "email") return errorResp("1003", "Invalid or expired code", res);
  const user = users[tempData.userId] || users[userId];
  if (!user) return errorResp("1002", "User not found", res);
  delete tempCodes[temporaryCode];
  const key = SECRET_KEY.substring(0, 32).padEnd(32, "0");
  const iv  = Buffer.from(key.substring(0, 16), "utf8");
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key, "utf8"), iv);
  let enc = cipher.update(user.email || "user@example.com", "utf8", "base64");
  enc += cipher.final("base64");
  return successResp(enc, res);
});

app.post("/user/getUserPhoneNumber", (req, res) => {
  const { temporaryCode, userId } = req.body;
  const tempData = tempCodes[temporaryCode];
  if (!tempData || tempData.type !== "phone") return errorResp("1003", "Invalid or expired code", res);
  const user = users[tempData.userId] || users[userId];
  if (!user) return errorResp("1002", "User not found", res);
  delete tempCodes[temporaryCode];
  const key = SECRET_KEY.substring(0, 32).padEnd(32, "0");
  const iv  = Buffer.from(key.substring(0, 16), "utf8");
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key, "utf8"), iv);
  let enc = cipher.update(user.phone || "+6512345678", "utf8", "base64");
  enc += cipher.final("base64");
  return successResp(enc, res);
});

app.post("/user/getUserNick", (req, res) => {
  const { userId } = req.body;
  const user = users[userId];
  if (!user) return errorResp("1002", "User not found", res);
  return successResp(user.nickName, res);
});

app.post("/user/getUserAvatar", (req, res) => {
  const { userId } = req.body;
  const user = users[userId];
  if (!user) return errorResp("1002", "User not found", res);
  return successResp(user.avatarUrl, res);
});

app.post("/message/send", (req, res) => {
  console.log(`  [message/send] AccountId=${req.body.AccountId}`);
  return successResp(true, res);
});

// ──────────────────────────────────────────────────────────────
// POST /v3/pay/transactions/jsapi  — Superapp-side order creation
//
// Called by: SAS Backend (forwarded from miniapp-backend)
// The super app backend records the order and returns a prepayId.
// In production this is where you'd interact with your payment
// processor (bank core system, card scheme, etc.)
// ──────────────────────────────────────────────────────────────
app.post("/v3/pay/transactions/jsapi", (req, res) => {
  const { out_trade_no, amount, payer, description, notify_url } = req.body;

  console.log(`  [pay/jsapi] out_trade_no=${out_trade_no} amount=${JSON.stringify(amount)}`);

  if (!out_trade_no || !amount || !payer) {
    return res.json({ returnCode: "1001", returnMessage: "Missing required fields", requestId: uuidv4() });
  }

  // In production: call your bank/payment processor here to reserve funds
  // For now: generate a prepayId that represents the reserved payment slot
  const prepayId = `prepay_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;

  console.log(`  [pay/jsapi] Generated prepayId=${prepayId}`);

  // Log for audit
  paymentLogs.push({
    type:         "ORDER_CREATED",
    out_trade_no,
    prepayId,
    openid:       payer.openid,
    amount,
    description,
    notify_url,
    createdAt:    Date.now(),
  });
  if (paymentLogs.length > 100) paymentLogs.shift();

  return res.json({
    returnCode:    "0",
    returnMessage: "ok",
    data:          { prepayId },
    requestId:     uuidv4(),
  });
});

// ──────────────────────────────────────────────────────────────
// POST /payment/notify  — Super app confirms payment to SAS
//
// Called by: Android super app (MiniOpenApiProxyImpl.requestPayment)
// After user enters PIN/biometric on the payment UI, the Android
// app calls this endpoint to tell SAS that payment is confirmed.
// SAS then delivers the result to the miniapp-backend /notify_payBack.
//
// In a real integration, this is triggered internally by the
// payment SDK after the bank confirms the debit.
// ──────────────────────────────────────────────────────────────
app.post("/payment/notify", async (req, res) => {
  const { out_trade_no, prepay_id, openid, amount, status } = req.body;

  console.log(`  [payment/notify] out_trade_no=${out_trade_no} status=${status}`);

  if (!out_trade_no) return errorResp("1001", "Missing out_trade_no", res);

  // Log payment event
  paymentLogs.push({
    type:         "PAYMENT_CONFIRMED",
    out_trade_no,
    prepay_id,
    openid,
    amount,
    status:       status || "SUCCESS",
    confirmedAt:  Date.now(),
  });
  if (paymentLogs.length > 100) paymentLogs.shift();

  // Forward payment result to SAS OpenServer
  // SAS will then asynchronously notify the miniapp-backend /notify_payBack
  try {
    console.log(`  [payment/notify] Notifying SAS of payment result ...`);
    const sasResp = await httpPost(`${TCSAS_OPENSERVER}/payment/notify`, {
      event_type:    status === "FAILED" ? "TRANSACTION.FAIL" : "TRANSACTION.SUCCESS",
      out_trade_no,
      prepay_id,
      openid,
      amount,
      create_time:  new Date().toISOString(),
    });
    console.log(`  [payment/notify] SAS response:`, JSON.stringify(sasResp));
  } catch (err) {
    // Log but don't fail — SAS may retry, and we've already recorded locally
    console.error(`  [payment/notify] SAS notify failed (non-fatal):`, err.message);
  }

  return successResp({ confirmed: true, out_trade_no }, res);
});

// ──────────────────────────────────────────────────────────────
// POST /payment/callback  — SAS notifies super app of result
//
// Called by: SAS Backend (asynchronous, after payment completes)
// This is where the super app learns the final payment outcome.
// ──────────────────────────────────────────────────────────────
app.post("/payment/callback", (req, res) => {
  const { event_type, out_trade_no } = req.body;

  console.log(`  [payment/callback] event_type=${event_type} out_trade_no=${out_trade_no}`);

  paymentLogs.push({
    type:        "SAS_CALLBACK",
    event_type,
    out_trade_no,
    body:        req.body,
    receivedAt:  Date.now(),
  });
  if (paymentLogs.length > 100) paymentLogs.shift();

  // ACK to SAS
  return res.json({ returnCode: "0", returnMessage: "ok", requestId: uuidv4() });
});

// GET /health
app.get("/health", (req, res) => {
  res.json({
    status:         "ok",
    server:         "superapp-backend",
    time:           new Date().toISOString(),
    known_users:    Object.keys(users),
    payment_events: paymentLogs.length,
  });
});

// Catch all unmatched
app.use((req, res) => {
  console.log(`\n[SUPERAPP] ⚠️  UNMATCHED: ${req.method} ${req.path}`);
  console.log("  Body:", JSON.stringify(req.body));
  res.status(404).json({ error: "Not found", path: req.path });
});

const PORT = process.env.SUPERAPP_PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ SuperApp Backend (Payment) running on http://localhost:${PORT}`);
  console.log(`   SecretKey:          ${SECRET_KEY.substring(0, 8)}...`);
  console.log(`   Known users:        ${JSON.stringify(Object.keys(users))}`);
  console.log(`\n   Payment endpoints:`);
  console.log(`   POST /v3/pay/transactions/jsapi  — create order (called by SAS)`);
  console.log(`   POST /payment/notify             — confirm payment (called by Android)`);
  console.log(`   POST /payment/callback           — SAS payment result callback`);
});
