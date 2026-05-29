// logger.js — request/response capture for miniapp-backend
// Stores logs to ./logs/requests.json (max 500 entries)
// Used by: index.js (middleware) and dashboard.js (read/clear)

const fs   = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const LOG_DIR  = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "requests.json");
const MAX_LOGS = 500;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "[]", "utf8");

function readLogs() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8") || "[]"); }
  catch { return []; }
}

function writeLogs(logs) {
  const tmp = LOG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(logs), "utf8");
  fs.renameSync(tmp, LOG_FILE);  // atomic — avoids corruption
}

function clearLogs() {
  writeLogs([]);
}

// Called after response is sent — never blocks the request
function appendLog(entry) {
  setImmediate(() => {
    try {
      const logs = readLogs();
      logs.unshift(entry);
      if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
      writeLogs(logs);
    } catch (e) {
      console.error("[LOGGER] write error:", e.message);
    }
  });
}

// Express middleware — attaches to every route except /dashboard and /logs/*
function captureMiddleware(req, res, next) {
  if (req.path === "/dashboard" || req.path.startsWith("/logs")) return next();

  const start = Date.now();
  const entry = {
    id:         uuidv4(),
    time:       new Date().toISOString(),
    method:     req.method,
    path:       req.path,
    ip:         req.headers["x-real-ip"] || req.ip,
    reqHeaders: req.headers,
    reqBody:    req.body,
    status:     null,
    resBody:    null,
    duration:   null,
  };

  // Intercept res.json to capture response body + status code
  const origJson = res.json.bind(res);
  res.json = (body) => {
    entry.status   = res.statusCode;
    entry.resBody  = body;
    entry.duration = Date.now() - start;
    appendLog(entry);
    return origJson(body);
  };

  next();
}

module.exports = { readLogs, writeLogs, clearLogs, captureMiddleware, LOG_FILE };
