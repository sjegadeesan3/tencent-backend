# TCSAS Backend Servers - Setup Guide

Two separate Node.js servers:

| Server | Port | Purpose |
|--------|------|---------|
| `miniapp-backend` | 3000 | Called directly by the mini app (fetch.js) |
| `superapp-backend` | 3001 | Called by TCSAS OpenServer for user verification |

---

## Step 1 — Install dependencies

```bash
# MiniApp backend
cd miniapp-backend
npm install

# SuperApp backend
cd ../superapp-backend
npm install
```

---

## Step 2 — Get your APPSECRET from TCSAS Console

1. Go to TCSAS Console
2. Mini program management → select `mpvc3tdaldpq7zpu`
3. Development management → Key management → Generate key
4. Copy the appsecret
5. Paste it in `miniapp-backend/.env`:
   ```
   APPSECRET=your_actual_appsecret_here
   ```

---

## Step 3 — Start both servers

Open TWO terminal windows:

**Terminal 1 — MiniApp backend:**
```bash
cd miniapp-backend
npm start
# Running on http://localhost:3000
```

**Terminal 2 — SuperApp backend:**
```bash
cd superapp-backend
npm start
# Running on http://localhost:3001
```

---

## Step 4 — Expose both via ngrok

Open TWO more terminal windows:

**Terminal 3 — Expose MiniApp backend:**
```bash
ngrok http 3000
# Copy the https URL e.g. https://abc123.ngrok-free.app
```

**Terminal 4 — Expose SuperApp backend:**
```bash
ngrok http 3001
# Copy the https URL e.g. https://def456.ngrok-free.app
```

---

## Step 5 — Update fetch.js in mini app

Edit `utils/fetch.js`:
```js
const appid = "mpvc3tdaldpq7zpu";                        // already correct
const host = "https://abc123.ngrok-free.app";            // ← your miniapp-backend ngrok URL
```

---

## Step 6 — Configure TCSAS Console

### A. Set SuperApp backend URL
Go to: **Application management → Configuration management → Service domain**
Set it to your superapp-backend ngrok URL:
```
https://def456.ngrok-free.app
```
This tells TCSAS OpenServer where to call /user/checkUser etc.

### B. Whitelist MiniApp backend domain
Go to: **Application management → Configuration management → Request domain**
Add your miniapp-backend ngrok URL:
```
https://abc123.ngrok-free.app
```
This allows wx.request in the mini app to call your server.

---

## Step 7 — Re-upload mini app

After updating fetch.js:
1. Open mini app project in TCMPP IDE
2. Upload new version
3. The Android super app will pull the new version on next launch

---

## Step 8 — Test the login flow

When you click "click Login" in the mini app, watch the logs:

**SuperApp backend terminal should show:**
```
[SUPERAPP] POST /user/checkUser
  Body: { "userId": "mock_user_001" }
  [checkUser] User found: mock_user_001
```

**MiniApp backend terminal should show:**
```
[MINIAPP] POST /getUserInfo
  Body: { "appid": "mpvc3tdaldpq7zpu", "code": "<real_code>" }
  [getUserInfo] jscode2session response: { openid: "...", session_key: "..." }
  [getUserInfo] New user created: openid=...
```

**Mini app should show:** "login finish" toast and user center page updates.

---

## API Reference

### MiniApp Backend (port 3000)

| Method | Path | Called by | Purpose |
|--------|------|-----------|---------|
| POST | /getUserInfo | mini app fetch.js | Login exchange |
| POST | /payOrderV3 | mini app fetch.js | Create payment order |
| GET | /health | you | Health check |

### SuperApp Backend (port 3001)

| Method | Path | Called by | Purpose |
|--------|------|-----------|---------|
| POST | /user/checkUser | TCSAS OpenServer | Verify user exists |
| POST | /user/getUserInfoTemporaryCode | TCSAS OpenServer | Get temp code for phone/email |
| POST | /user/getUserEmail | TCSAS OpenServer | Return encrypted email |
| POST | /user/getUserPhoneNumber | TCSAS OpenServer | Return encrypted phone |
| POST | /user/getUserNick | TCSAS OpenServer | Return user nickname |
| POST | /user/getUserAvatar | TCSAS OpenServer | Return avatar URL |
| POST | /message/send | TCSAS OpenServer | Receive subscription messages |
| POST | /v3/pay/transactions/jsapi | TCSAS OpenServer | Create payment order |
| POST | /payment/callback | TCSAS OpenServer | Receive payment result |
| GET | /health | you | Health check |

---

## Current mock users

The superapp backend has one pre-seeded user:
```js
userId: "mock_user_001"    // this is what getAccount() returns in Android
nickName: "Test User"
phone: "+6512345678"
email: "testuser@example.com"
```

This matches `MiniAppProxyImpl.getAccount()` which returns `"mock_user_001"`.

When TCSAS OpenServer calls /user/checkUser with userId="mock_user_001",
the server confirms the user exists and login proceeds.

---

## Important notes

1. **ngrok URLs change every restart** (free tier). Update fetch.js and TCSAS Console each time.
   Use ngrok paid plan or a static domain to avoid this.

2. **In-memory storage resets on restart**. Users will need to log in again.
   Replace with a real database (SQLite for local dev, PostgreSQL for production).

3. **APPSECRET is sensitive**. Never commit it to git. Keep it only in .env file.

4. **Payment is simulated**. The /payOrderV3 returns a mock paySign.
   Real payment requires: merchant account setup in TCSAS console + RSA key pair generation.
