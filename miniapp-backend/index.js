require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { v4: uuidv4 } = require("uuid");

const app = express();

// ── IMPORTANT: Skip ngrok browser warning page ───────────────
app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const TCSAS_OPENSERVER = process.env.TCSAS_OPENSERVER || "https://api-sg.tcmpp.com";
const APPSECRET = process.env.APPSECRET || "YOUR_APPSECRET_FROM_TCSAS_CONSOLE";
const JWT_SECRET = process.env.JWT_SECRET || "change_this_to_a_random_secret_string";

// ── Logging ───────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`\n[MINIAPP] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log("  Content-Type:", req.headers["content-type"]);
  console.log("  Body:", JSON.stringify(req.body, null, 2));
  next();
});

// ── In-memory users ───────────────────────────────────────────
const users = {};

// ── Simple JWT ────────────────────────────────────────────────
function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })
  ).toString("base64url");
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

// ── HTTP GET helper ───────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    }).on("error", reject);
  });
}

// POST /getUserInfo
app.post("/getUserInfo", async (req, res) => {
  console.log("  Raw body keys:", Object.keys(req.body || {}));
  const { appid, code } = req.body;

  if (!appid) return res.json({ code: 400, data: { msg: "Missing appid" } });
  if (!code) {
    console.log("  ERROR: code is missing. appid received:", appid);
    return res.json({
      code: 400,
      data: { msg: "Missing code — wx.login() did not return a code. Check superapp backend /user/checkUser is reachable." },
    });
  }

  console.log(`  appid=${appid} code=${code}`);

  // Call TCSAS jscode2session
  const url =
    `${TCSAS_OPENSERVER}/sns/jscode2session` +
    `?appid=${appid}&secret=${APPSECRET}&js_code=${code}&grant_type=authorization_code`;

  console.log("  Calling jscode2session:", url);

  let sessionData;
  try {
    sessionData = await httpGet(url);
    console.log("  jscode2session response:", JSON.stringify(sessionData));
  } catch (err) {
    console.error("  jscode2session FAILED:", err.message);
    return res.json({ code: 500, data: { msg: "Failed to contact TCSAS: " + err.message } });
  }

  if (sessionData.errcode && sessionData.errcode !== 0) {
    return res.json({ code: 401, data: { msg: `TCSAS error ${sessionData.errcode}: ${sessionData.errmsg}` } });
  }

  const { openid } = sessionData;
  if (!openid) {
    return res.json({ code: 401, data: { msg: "No openid returned. Response: " + JSON.stringify(sessionData) } });
  }

  // Create or fetch user
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
    console.log(`  New user created: openid=${openid}`);
  } else {
    console.log(`  Existing user: openid=${openid}`);
  }

  const token = createToken({ openid, userId: user.id });

  console.log(`  LOGIN SUCCESS userName=${user.userName}`);
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

// POST /payOrderV3
app.post("/payOrderV3", async (req, res) => {
  const { goods_detail, discount = 0, token } = req.body;

  if (!token) return res.json({ code: 401, data: { msg: "Missing token — please login first" } });

  const payload = verifyToken(token);
  if (!payload) return res.json({ code: 401, data: { msg: "Invalid or expired token" } });

  const user = users[payload.openid];
  if (!user) return res.json({ code: 401, data: { msg: "User not found" } });

  if (!goods_detail || goods_detail.length === 0) {
    return res.json({ code: 400, data: { msg: "No goods in order" } });
  }

  const prepayId = `prepay_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(10).toString("hex");

  console.log(`  payOrderV3 prepayId=${prepayId}`);

  return res.json({
    code: 200,
    timeStamp,
    nonceStr,
    package: `prepay_id=${prepayId}`,
    signType: "RSA",
    paySign: `MOCK_PAY_SIGN_${crypto.randomBytes(8).toString("hex")}`,
  });
});

// GET /health
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "miniapp-backend",
    time: new Date().toISOString(),
    appsecret_set: APPSECRET !== "YOUR_APPSECRET_FROM_TCSAS_CONSOLE",
    users_in_memory: Object.keys(users).length,
  });
});

const PORT = process.env.MINIAPP_PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ MiniApp Backend running on http://localhost:${PORT}`);
  console.log(`   APPSECRET set: ${APPSECRET !== "YOUR_APPSECRET_FROM_TCSAS_CONSOLE" ? "YES ✅" : "NO ❌ set in .env"}`);
  console.log(`   ngrok-skip-browser-warning header: ENABLED`);
});
