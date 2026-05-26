require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const app = express();

// ── Skip ngrok browser warning ────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Config ────────────────────────────────────────────────────
const SECRET_KEY = process.env.APP_ENCRYPT_KEY || "0123456789abcdef0123456789abcdef";

// ── TC-Signature verification ─────────────────────────────────
// TCSAS generates: AES-ECB(timestamp, secretKey) → hex string
// We verify by generating the same and comparing
function verifyTCSignature(tcTimestamp, tcSignature) {
  try {
    const key = Buffer.from(SECRET_KEY.substring(0, 32).padEnd(32, "0"), "utf8");
    const timestamp = Buffer.from(tcTimestamp, "utf8");
    // PKCS7 padding
    const blockSize = 16;
    const padding = blockSize - (timestamp.length % blockSize);
    const padded = Buffer.concat([timestamp, Buffer.alloc(padding, padding)]);
    // AES-ECB encrypt
    const cipher = crypto.createCipheriv("aes-256-ecb", key, null);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    const expected = encrypted.toString("hex");
    console.log(`  [verify] expected=${expected} received=${tcSignature}`);
    return expected === tcSignature;
  } catch (e) {
    console.error("  [verify] signature error:", e.message);
    return false;
  }
}

// ── Full request logger ───────────────────────────────────────
app.use((req, res, next) => {
  console.log(`\n[SUPERAPP] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log("  ALL Headers:", JSON.stringify(req.headers, null, 2));
  console.log("  Body:", JSON.stringify(req.body, null, 2));
  next();
});

// ── In-memory users ───────────────────────────────────────────
const users = {
  mock_user_001: {
    userId: "mock_user_001",
    nickName: "Test User",
    avatarUrl: "https://picsum.photos/100",
    phone: "+6512345678",
    email: "testuser@example.com",
    exists: true,
  },
};

const tempCodes = {};

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

// POST /user/checkUser
app.post("/user/checkUser", (req, res) => {
  const tcTimestamp = req.headers["tc-timestamp"];
  const tcSignature = req.headers["tc-signature"];
  
  console.log(`  [checkUser] tc-timestamp=${tcTimestamp} tc-signature=${tcSignature}`);
  
  // Verify signature if provided by TCSAS
  if (tcTimestamp && tcSignature) {
    const valid = verifyTCSignature(tcTimestamp, tcSignature);
    console.log(`  [checkUser] Signature valid: ${valid}`);
    // Note: Don't reject if invalid during development - just log
  }

  const { userId } = req.body;
  console.log(`  [checkUser] userId=${userId}`);

  if (!userId) return errorResp("1001", "userId is required", res);

  if (!users[userId]) {
    users[userId] = {
      userId,
      nickName: `User_${userId.substring(0, 6)}`,
      avatarUrl: "https://picsum.photos/100",
      phone: "",
      email: "",
      exists: true,
    };
    console.log(`  [checkUser] Auto-created user: ${userId}`);
  } else {
    console.log(`  [checkUser] User EXISTS: ${userId}`);
  }

  return successResp(true, res);
});

// POST /checkUser
app.post("/checkUser", (req, res) => {
  const tcTimestamp = req.headers["tc-timestamp"];
  const tcSignature = req.headers["tc-signature"];
  
  console.log(`  [checkUser] tc-timestamp=${tcTimestamp} tc-signature=${tcSignature}`);
  
  // Verify signature if provided by TCSAS
  if (tcTimestamp && tcSignature) {
    const valid = verifyTCSignature(tcTimestamp, tcSignature);
    console.log(`  [checkUser] Signature valid: ${valid}`);
    // Note: Don't reject if invalid during development - just log
  }

  const { userId } = req.body;
  console.log(`  [checkUser] userId=${userId}`);

  if (!userId) return errorResp("1001", "userId is required", res);

  if (!users[userId]) {
    users[userId] = {
      userId,
      nickName: `User_${userId.substring(0, 6)}`,
      avatarUrl: "https://picsum.photos/100",
      phone: "",
      email: "",
      exists: true,
    };
    console.log(`  [checkUser] Auto-created user: ${userId}`);
  } else {
    console.log(`  [checkUser] User EXISTS: ${userId}`);
  }

  return successResp(true, res);
});

// POST /user/getUserInfoTemporaryCode
app.post("/user/getUserInfoTemporaryCode", (req, res) => {
  const { userId, type } = req.body;
  console.log(`  [getUserInfoTemporaryCode] userId=${userId} type=${type}`);
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

// POST /user/getUserEmail
app.post("/user/getUserEmail", (req, res) => {
  const { temporaryCode, userId } = req.body;
  const tempData = tempCodes[temporaryCode];
  if (!tempData || tempData.type !== "email") return errorResp("1003", "Invalid or expired code", res);
  const user = users[tempData.userId] || users[userId];
  if (!user) return errorResp("1002", "User not found", res);
  delete tempCodes[temporaryCode];
  const key = SECRET_KEY.substring(0, 32).padEnd(32, "0");
  const iv = Buffer.from(key.substring(0, 16), "utf8");
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key, "utf8"), iv);
  let enc = cipher.update(user.email || "user@example.com", "utf8", "base64");
  enc += cipher.final("base64");
  return successResp(enc, res);
});

// POST /user/getUserPhoneNumber
app.post("/user/getUserPhoneNumber", (req, res) => {
  const { temporaryCode, userId } = req.body;
  const tempData = tempCodes[temporaryCode];
  if (!tempData || tempData.type !== "phone") return errorResp("1003", "Invalid or expired code", res);
  const user = users[tempData.userId] || users[userId];
  if (!user) return errorResp("1002", "User not found", res);
  delete tempCodes[temporaryCode];
  const key = SECRET_KEY.substring(0, 32).padEnd(32, "0");
  const iv = Buffer.from(key.substring(0, 16), "utf8");
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key, "utf8"), iv);
  let enc = cipher.update(user.phone || "+6512345678", "utf8", "base64");
  enc += cipher.final("base64");
  return successResp(enc, res);
});

// POST /user/getUserNick
app.post("/user/getUserNick", (req, res) => {
  const { userId } = req.body;
  const user = users[userId];
  if (!user) return errorResp("1002", "User not found", res);
  return successResp(user.nickName, res);
});

// POST /user/getUserAvatar
app.post("/user/getUserAvatar", (req, res) => {
  const { userId } = req.body;
  const user = users[userId];
  if (!user) return errorResp("1002", "User not found", res);
  return successResp(user.avatarUrl, res);
});

// POST /message/send
app.post("/message/send", (req, res) => {
  console.log(`  [message/send] AccountId=${req.body.AccountId}`);
  return successResp(true, res);
});

// POST /v3/pay/transactions/jsapi
app.post("/v3/pay/transactions/jsapi", (req, res) => {
  const { out_trade_no, amount, payer } = req.body;
  console.log(`  [pay/jsapi] out_trade_no=${out_trade_no}`);
  if (!out_trade_no || !amount || !payer) {
    return res.json({ returnCode: "1001", returnMessage: "Missing fields", requestId: uuidv4() });
  }
  const prepayId = `prepay_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
  return res.json({ returnCode: "0", returnMessage: "ok", data: { prepayId }, requestId: uuidv4() });
});

// POST /payment/callback
app.post("/payment/callback", (req, res) => {
  console.log(`  [payment/callback] event_type=${req.body.event_type}`);
  return res.json({ returnCode: "0", returnMessage: "ok", requestId: uuidv4() });
});

// GET /health
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "superapp-backend", time: new Date().toISOString(), known_users: Object.keys(users) });
});

// Catch ALL requests - so we can see if TCSAS hits any unexpected path
app.use((req, res, next) => {
  console.log(`\n[SUPERAPP] ⚠️ UNMATCHED REQUEST: ${req.method} ${req.path}`);
  console.log("  Body:", JSON.stringify(req.body));
  res.status(404).json({ error: "Not found", path: req.path });
});

const PORT = process.env.SUPERAPP_PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ SuperApp Backend running on http://localhost:${PORT}`);
  console.log(`   SecretKey: ${SECRET_KEY.substring(0, 8)}...`);
  console.log(`   Known users: ${JSON.stringify(Object.keys(users))}`);
});