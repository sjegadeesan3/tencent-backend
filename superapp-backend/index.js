// index.js — SuperApp Backend
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

// ── Logger middleware ─────────────────────────────────────────
app.use(captureMiddleware);

// ── Dashboard routes ──────────────────────────────────────────
app.use(dashboard);

// ── Console logger ────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/dashboard" || req.path.startsWith("/logs")) return next();
  console.log(`\n[SUPERAPP] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log("  Body:", JSON.stringify(req.body, null, 2));
  next();
});

// ── ENV ───────────────────────────────────────────────────────
const SECRET_KEY          = process.env.APP_ENCRYPT_KEY    || "0123456789abcdef0123456789abcdef";
const TCSAS_OPENSERVER    = process.env.TCSAS_OPENSERVER  || "https://api-sg.tcmpp.com";
const MINIAPP_BACKEND_URL = process.env.MINIAPP_BACKEND_URL || "https://tencentminiapptesting.xyz/miniapp";
// Shared secret so miniapp-backend trusts notifications from superapp-backend
const NOTIFY_SECRET       = process.env.NOTIFY_SECRET       || "superapp_miniapp_shared_secret_2026";

// ── Helpers ───────────────────────────────────────────────────
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

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj  = new URL(url);
    const options = { hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith("https") ? 443 : 80),
      path: urlObj.pathname + urlObj.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } };
    const client = url.startsWith("https") ? https : http;
    const req    = client.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on("error", reject); req.write(payload); req.end();
  });
}

function ok(data, res)       { return res.json({ returnCode: "0", returnMessage: "ok", data, requestId: uuidv4() }); }
function fail(code, msg, res){ return res.json({ returnCode: code, returnMessage: msg, requestId: uuidv4() }); }

// ── In-memory state ───────────────────────────────────────────
const users = {
  mock_user_001: { userId: "mock_user_001", nickName: "Test User",
    avatarUrl: "https://picsum.photos/100", phone: "+6512345678", email: "testuser@example.com", exists: true },
};
const tempCodes = {};

function generateTempCode(userId, type) {
  const code = crypto.randomBytes(16).toString("hex");
  tempCodes[code] = { userId, type, createdAt: Date.now() };
  setTimeout(() => delete tempCodes[code], 5 * 60 * 1000);
  return code;
}

// ── Login endpoints ───────────────────────────────────────────
app.post("/user/checkUser", (req, res) => {
  const { userId } = req.body;
  if (!userId) return fail("1001", "userId is required", res);
  if (!users[userId]) {
    users[userId] = { userId, nickName: `User_${userId.substring(0, 6)}`,
      avatarUrl: "https://picsum.photos/100", phone: "", email: "", exists: true };
  }
  return ok(true, res);
});

app.post("/checkUser", (req, res) => {
  const { userId } = req.body;
  if (!userId) return fail("1001", "userId is required", res);
  if (!users[userId]) {
    users[userId] = { userId, nickName: `User_${userId.substring(0, 6)}`,
      avatarUrl: "https://picsum.photos/100", phone: "", email: "", exists: true };
  }
  return ok(true, res);
});

app.post("/user/getUserInfoTemporaryCode", (req, res) => {
  const { userId, type } = req.body;
  if (!userId || !type) return fail("1001", "userId and type required", res);
  const user = users[userId];
  if (!user) return fail("1002", "User not found", res);
  const code = generateTempCode(userId, type);
  let masked = "";
  if (type === "phone") masked = (user.phone || "+6512345678").replace(/(\+\d{2})(\d+)(\d{2})$/, "$1****$3");
  else if (type === "email") { const [l,d] = (user.email || "user@example.com").split("@"); masked = `${l.substring(0,2)}****@${d}`; }
  return ok({ data: masked, code }, res);
});

app.post("/user/getUserEmail", (req, res) => {
  const { temporaryCode, userId } = req.body;
  const td = tempCodes[temporaryCode];
  if (!td || td.type !== "email") return fail("1003", "Invalid or expired code", res);
  const user = users[td.userId] || users[userId];
  if (!user) return fail("1002", "User not found", res);
  delete tempCodes[temporaryCode];
  const key = SECRET_KEY.substring(0, 32).padEnd(32, "0");
  const c   = crypto.createCipheriv("aes-256-cbc", Buffer.from(key,"utf8"), Buffer.from(key.substring(0,16),"utf8"));
  return ok(c.update(user.email||"user@example.com","utf8","base64")+c.final("base64"), res);
});

app.post("/user/getUserPhoneNumber", (req, res) => {
  const { temporaryCode, userId } = req.body;
  const td = tempCodes[temporaryCode];
  if (!td || td.type !== "phone") return fail("1003", "Invalid or expired code", res);
  const user = users[td.userId] || users[userId];
  if (!user) return fail("1002", "User not found", res);
  delete tempCodes[temporaryCode];
  const key = SECRET_KEY.substring(0, 32).padEnd(32, "0");
  const c   = crypto.createCipheriv("aes-256-cbc", Buffer.from(key,"utf8"), Buffer.from(key.substring(0,16),"utf8"));
  return ok(c.update(user.phone||"+6512345678","utf8","base64")+c.final("base64"), res);
});

app.post("/user/getUserNick",   (req, res) => {
  const user = users[req.body.userId];
  return user ? ok(user.nickName, res) : fail("1002", "User not found", res);
});
app.post("/user/getUserAvatar", (req, res) => {
  const user = users[req.body.userId];
  return user ? ok(user.avatarUrl, res) : fail("1002", "User not found", res);
});
app.post("/message/send", (req, res) => ok(true, res));

// ── Payment endpoints ─────────────────────────────────────────
app.post("/v3/pay/transactions/jsapi", (req, res) => {
  const { out_trade_no, amount, payer } = req.body;
  if (!out_trade_no || !amount || !payer) return res.json({ returnCode: "1001", returnMessage: "Missing fields", requestId: uuidv4() });
  const prepayId = `prepay_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
  return res.json({ returnCode: "0", returnMessage: "ok", data: { prepayId }, requestId: uuidv4() });
});

app.post("/payment/notify", async (req, res) => {
  const { out_trade_no, prepay_id, openid, amount, status } = req.body;
  if (!out_trade_no) return fail("1001", "Missing out_trade_no", res);

  const event_type = status === "FAILED" ? "TRANSACTION.FAIL" : "TRANSACTION.SUCCESS";

  // Step 1: Forward to SAS (for production payment settlement)
  try {
    await httpPost(`${TCSAS_OPENSERVER}/payment/notify`, {
      event_type, out_trade_no, prepay_id, openid, amount,
      create_time: new Date().toISOString(),
    });
  } catch (err) { console.error("  [payment/notify] SAS notify failed:", err.message); }

  // Step 2: Notify miniapp-backend /notify_payBack
  // superapp-backend is the ONLY caller of miniapp-backend — not Android directly.
  // This is architecturally correct: super app → superapp-backend → miniapp-backend.
  // HMAC signature proves this came from superapp-backend, not a forged request.
  try {
    const payload   = `${out_trade_no}:${prepay_id}:${event_type}`;
    const signature = require("crypto").createHmac("sha256", NOTIFY_SECRET)
                        .update(payload).digest("hex");
    await httpPost(`${MINIAPP_BACKEND_URL}/notify_payBack`, {
      event_type, out_trade_no, prepay_id, signature,
    });
    console.log(`  [payment/notify] miniapp-backend notified ✅`);
  } catch (err) { console.error("  [payment/notify] miniapp-backend notify failed:", err.message); }

  return ok({ confirmed: true, out_trade_no }, res);
});

app.post("/payment/callback", (req, res) => {
  return res.json({ returnCode: "0", returnMessage: "ok", requestId: uuidv4() });
});

// ── Health ────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "superapp-backend", time: new Date().toISOString(),
    known_users: Object.keys(users) });
});

app.use((req, res) => res.status(404).json({ error: "Not found", path: req.path }));

const PORT = process.env.SUPERAPP_PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ SuperApp Backend running on http://localhost:${PORT}`);
  console.log(`   Dashboard: https://tencentminiapptesting.xyz/superapp/dashboard`);
});
