// serverDashboard.js — Unified Server Dashboard Router
const express  = require("express");
const fs       = require("fs");
const path     = require("path");
const { exec } = require("child_process");

const router = express.Router();

const NGINX_LOG = "/var/log/nginx/access.log";
const PM2_LOGS  = {
  superapp: {
    out: "/root/.pm2/logs/superapp-backend-out.log",
    err: "/root/.pm2/logs/superapp-backend-error.log"
  },
  miniapp: {
    out: "/root/.pm2/logs/miniapp-backend-out.log",
    err: "/root/.pm2/logs/miniapp-backend-error.log"
  },
  coffee: {
    out: "/root/.pm2/logs/coffee-miniapp-backend-out.log",
    err: "/root/.pm2/logs/coffee-miniapp-backend-error.log"
  }
};

const SKIP_PATHS = [
  "logs/data", "favicon", "serverDashboard",
  ".env", "wp-admin", "wordpress", ".php", ".git",
  "robots.txt", "poweredby"
];

function readLastLines(filePath, n) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").filter(Boolean).slice(-n);
  } catch { return []; }
}

function parseNginxLine(line) {
  const m = line.match(/^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) \S+" (\d+) (\d+) "[^"]*" "([^"]*)"/);
  if (!m) return null;
  return { ip: m[1], time: m[2], method: m[3], path: m[4], status: parseInt(m[5]), bytes: m[6], ua: m[7] };
}

function shouldSkip(line) {
  return SKIP_PATHS.some(function(p) { return line.indexOf(p) >= 0; });
}

// Serve HTML
router.get("/", function(req, res) {
  const htmlPath = path.join(__dirname, "serverDashboard.html");
  res.sendFile(htmlPath);
});

// Serve client JS
router.get("/client.js", function(req, res) {
  const jsPath = path.join(__dirname, "serverDashboardClient.js");
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(jsPath);
});

// API: nginx logs
router.get("/api/nginx", function(req, res) {
  const lines = readLastLines(NGINX_LOG, 500)
    .filter(function(l) { return !shouldSkip(l); })
    .map(parseNginxLine)
    .filter(Boolean)
    .reverse();
  res.json(lines);
});

// API: pm2 logs
router.get("/api/pm2/:service", function(req, res) {
  const svc = req.params.service;
  if (!PM2_LOGS[svc]) return res.json([]);
  const out = readLastLines(PM2_LOGS[svc].out, 300);
  const err = readLastLines(PM2_LOGS[svc].err, 50).map(function(l) { return "[ERROR] " + l; });
  res.json([...err, ...out].slice(-300).reverse());
});

// API: clear nginx
router.post("/api/nginx/clear", function(req, res) {
  exec("sudo truncate -s 0 /var/log/nginx/access.log", function(e) {
    res.json({ ok: !e, error: e ? e.message : null });
  });
});

// API: flush pm2
router.post("/api/pm2/:service/flush", function(req, res) {
  const svc = req.params.service;
  const name = svc === "superapp" ? "superapp-backend"
             : svc === "miniapp"  ? "miniapp-backend"
             : "coffee-miniapp-backend";
  exec("pm2 flush " + name, function(e) {
    res.json({ ok: !e, error: e ? e.message : null });
  });
});

module.exports = router;
