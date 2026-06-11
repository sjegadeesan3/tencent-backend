// serverDashboard.js — Unified Server Dashboard
// Mount this in superapp-backend: app.use(require('./serverDashboard'))
// Serves at /serverDashboard

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const { exec } = require("child_process");

const router = express.Router();

const NGINX_LOG   = "/var/log/nginx/access.log";
const PM2_LOGS    = {
  superapp: { out: "/root/.pm2/logs/superapp-backend-out.log",    err: "/root/.pm2/logs/superapp-backend-error.log" },
  miniapp:  { out: "/root/.pm2/logs/miniapp-backend-out.log",     err: "/root/.pm2/logs/miniapp-backend-error.log" },
  coffee:   { out: "/root/.pm2/logs/coffee-miniapp-backend-out.log", err: "/root/.pm2/logs/coffee-miniapp-backend-error.log" },
};

function readLastLines(filePath, n = 200) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").filter(Boolean).slice(-n);
  } catch { return []; }
}

function parseNginxLine(line) {
  // 43.173.146.178 - - [11/Jun/2026:12:29:42 +0800] "POST /superapp/v3/pay HTTP/1.1" 200 81 "-" "Go-http-client/1.1"
  const m = line.match(/^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) \S+" (\d+) (\d+) "[^"]*" "([^"]*)"/);
  if (!m) return null;
  return { ip: m[1], time: m[2], method: m[3], path: m[4], status: parseInt(m[5]), bytes: m[6], ua: m[7] };
}

function ipLabel(ip) {
  if (ip === "43.163.97.144") return { label: "CVM/SAS", color: "#6366f1" };
  if (ip === "27.54.50.98")   return { label: "Browser/Android", color: "#10b981" };
  if (ip.startsWith("43."))   return { label: "Tencent SAS", color: "#f59e0b" };
  return { label: ip, color: "#94a3b8" };
}

// API: nginx logs
router.get("/api/nginx", (req, res) => {
  const lines = readLastLines(NGINX_LOG, 500)
    .filter(l => !l.includes("logs/data") 
    && !l.includes("favicon") 
    && !l.includes("serverDashboard")
    && !l.includes(".env")
    && !l.includes("wp-admin")
    && !l.includes("wordpress")
    && !l.includes(".php")
    && !l.includes(".git"))
    .map(parseNginxLine)
    .filter(Boolean)
    .reverse();
  res.json(lines);
});

// API: pm2 logs
router.get("/api/pm2/:service", (req, res) => {
  const svc = req.params.service;
  if (!PM2_LOGS[svc]) return res.json([]);
  const out = readLastLines(PM2_LOGS[svc].out, 300);
  const err = readLastLines(PM2_LOGS[svc].err, 50).map(l => `[ERROR] ${l}`);
  res.json([...err, ...out].slice(-300).reverse());
});

// API: clear nginx log
router.post("/api/nginx/clear", (req, res) => {
  exec("sudo truncate -s 0 /var/log/nginx/access.log", (e) => {
    res.json({ ok: !e, error: e?.message });
  });
});

// API: flush pm2 logs
router.post("/api/pm2/:service/flush", (req, res) => {
  const svc = req.params.service;
  exec(`pm2 flush ${svc === "superapp" ? "superapp-backend" : svc === "miniapp" ? "miniapp-backend" : "coffee-miniapp-backend"}`, (e) => {
    res.json({ ok: !e, error: e?.message });
  });
});

// Dashboard HTML
router.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>UOB TMRW — Server Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #1c2128;
    --border: #30363d; --text: #e6edf3; --muted: #7d8590;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --blue: #58a6ff; --purple: #bc8cff; --teal: #39d353;
    --sas: #f59e0b; --android: #10b981; --cvm: #6366f1;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }

  .header {
    background: var(--bg2); border-bottom: 1px solid var(--border);
    padding: 12px 20px; display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 100;
  }
  .header h1 { font-size: 14px; font-weight: 600; color: var(--text); letter-spacing: 0.5px; }
  .header .badge { background: var(--green); color: #000; padding: 2px 8px; border-radius: 20px; font-size: 10px; font-weight: 700; }
  .header .actions { margin-left: auto; display: flex; gap: 8px; }
  .btn { background: var(--bg3); border: 1px solid var(--border); color: var(--muted); padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; transition: all 0.15s; }
  .btn:hover { border-color: var(--blue); color: var(--text); }
  .btn.danger:hover { border-color: var(--red); color: var(--red); }

  .layout { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto auto; gap: 1px; background: var(--border); height: calc(100vh - 49px); }
  .panel { background: var(--bg2); display: flex; flex-direction: column; overflow: hidden; }
  .panel.full-width { grid-column: 1 / -1; }

  .panel-header {
    background: var(--bg3); border-bottom: 1px solid var(--border);
    padding: 8px 14px; display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  }
  .panel-title { font-size: 11px; font-weight: 600; color: var(--text); text-transform: uppercase; letter-spacing: 1px; }
  .panel-count { background: var(--bg); color: var(--muted); padding: 1px 6px; border-radius: 10px; font-size: 10px; }
  .panel-actions { margin-left: auto; display: flex; gap: 6px; }

  .log-body { flex: 1; overflow-y: auto; padding: 8px 0; }
  .log-body::-webkit-scrollbar { width: 4px; }
  .log-body::-webkit-scrollbar-track { background: var(--bg); }
  .log-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* Nginx entries */
  .nginx-entry { display: grid; grid-template-columns: 80px 50px 60px 1fr 36px; gap: 8px; padding: 4px 14px; border-bottom: 1px solid rgba(48,54,61,0.4); align-items: center; transition: background 0.1s; }
  .nginx-entry:hover { background: var(--bg3); }
  .ip-badge { padding: 1px 6px; border-radius: 10px; font-size: 9px; font-weight: 700; text-align: center; }
  .method { font-weight: 700; }
  .method.POST { color: var(--yellow); }
  .method.GET  { color: var(--green); }
  .path { color: var(--blue); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { text-align: center; padding: 1px 4px; border-radius: 4px; font-weight: 700; font-size: 10px; }
  .status.s200 { background: rgba(63,185,80,0.15); color: var(--green); }
  .status.s404 { background: rgba(248,81,73,0.15); color: var(--red); }
  .status.s304 { background: rgba(88,166,255,0.15); color: var(--blue); }
  .status.s500 { background: rgba(248,81,73,0.3); color: var(--red); }

  /* PM2 log entries */
  .log-line { padding: 2px 14px; line-height: 1.6; border-bottom: 1px solid rgba(48,54,61,0.2); white-space: pre-wrap; word-break: break-all; }
  .log-line:hover { background: var(--bg3); }
  .log-line.error { color: var(--red); }
  .log-line.success { color: var(--green); }
  .log-line.info { color: var(--blue); }
  .log-line.warn { color: var(--yellow); }

  /* Legend */
  .legend { display: flex; gap: 12px; padding: 6px 14px; border-top: 1px solid var(--border); flex-shrink: 0; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; }

  /* Live indicator */
  .live { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--green); }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

  .empty { text-align: center; padding: 40px; color: var(--muted); }
  .time-col { color: var(--muted); font-size: 10px; }
</style>
</head>
<body>
<div class="header">
  <div class="live"><div class="live-dot"></div> LIVE</div>
  <h1>UOB TMRW — Server Dashboard</h1>
  <span class="badge">POC</span>
  <div class="actions">
    <button class="btn danger" onclick="clearAll()">Clear All Logs</button>
    <button class="btn" onclick="refresh()">Refresh</button>
  </div>
</div>

<div class="layout">
  <!-- Nginx Panel (full width) -->
  <div class="panel full-width" style="max-height:280px">
    <div class="panel-header">
      <span class="panel-title">🌐 Nginx Access Log</span>
      <span class="panel-count" id="nginx-count">0</span>
      <div class="panel-actions">
        <button class="btn danger" onclick="clearNginx()">Clear</button>
      </div>
    </div>
    <div class="log-body" id="nginx-log">
      <div class="empty">Loading...</div>
    </div>
    <div class="legend">
      <div class="legend-item"><div class="dot" style="background:#f59e0b"></div> Tencent SAS</div>
      <div class="legend-item"><div class="dot" style="background:#10b981"></div> Android/Browser</div>
      <div class="legend-item"><div class="dot" style="background:#6366f1"></div> CVM Internal</div>
    </div>
  </div>

  <!-- Superapp Backend -->
  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">⚡ Superapp Backend</span>
      <span class="panel-count" id="superapp-count">0</span>
      <div class="panel-actions">
        <button class="btn danger" onclick="flushPm2('superapp')">Flush</button>
      </div>
    </div>
    <div class="log-body" id="superapp-log"><div class="empty">Loading...</div></div>
  </div>

  <!-- Coffee Backend -->
  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">☕ Coffee Miniapp Backend</span>
      <span class="panel-count" id="coffee-count">0</span>
      <div class="panel-actions">
        <button class="btn danger" onclick="flushPm2('coffee')">Flush</button>
      </div>
    </div>
    <div class="log-body" id="coffee-log"><div class="empty">Loading...</div></div>
  </div>

  <!-- Ecommerce Backend -->
  <div class="panel" style="grid-column: 1 / -1; max-height: 200px">
    <div class="panel-header">
      <span class="panel-title">🛒 Ecommerce Miniapp Backend</span>
      <span class="panel-count" id="miniapp-count">0</span>
      <div class="panel-actions">
        <button class="btn danger" onclick="flushPm2('miniapp')">Flush</button>
      </div>
    </div>
    <div class="log-body" id="miniapp-log"><div class="empty">Loading...</div></div>
  </div>
</div>

<script>
const BASE = '/superapp';

function statusClass(s) {
  if (s >= 200 && s < 300) return 's200';
  if (s === 304) return 's304';
  if (s >= 400 && s < 500) return 's404';
  return 's500';
}

function ipInfo(ip) {
  if (ip === '43.163.97.144') return { label: 'CVM', color: '#6366f1' };
  if (ip === '27.54.50.98')   return { label: 'Client', color: '#10b981' };
  if (ip.startsWith('43.'))   return { label: 'SAS', color: '#f59e0b' };
  return { label: ip.split('.').slice(-2).join('.'), color: '#94a3b8' };
}

function formatTime(t) {
  const parts = t.split(':');
  return parts.slice(1).join(':').split(' ')[0];
}

async function loadNginx() {
  try {
    const res = await fetch(BASE + '/serverDashboard/api/nginx');
    const data = await res.json();
    const el = document.getElementById('nginx-log');
    document.getElementById('nginx-count').textContent = data.length;
    if (!data.length) { el.innerHTML = '<div class="empty">No requests yet</div>'; return; }
    el.innerHTML = data.map(e => {
      const ip = ipInfo(e.ip);
      return \`<div class="nginx-entry">
        <span class="ip-badge" style="background:\${ip.color}22;color:\${ip.color}">\${ip.label}</span>
        <span class="method \${e.method}">\${e.method}</span>
        <span class="time-col">\${formatTime(e.time)}</span>
        <span class="path" title="\${e.path}">\${e.path}</span>
        <span class="status \${statusClass(e.status)}">\${e.status}</span>
      </div>\`;
    }).join('');
  } catch(e) { console.error(e); }
}

function colorLine(line) {
  if (line.includes('[ERROR]') || line.includes('error') || line.includes('Error')) return 'error';
  if (line.includes('✅') || line.includes('SUCCESS') || line.includes('success')) return 'success';
  if (line.includes('SUPERAPP]') || line.includes('MINIAPP]') || line.includes('COFFEE]')) return 'info';
  if (line.includes('WARN') || line.includes('warn')) return 'warn';
  return '';
}

async function loadPm2(service) {
  try {
    const res = await fetch(BASE + '/serverDashboard/api/pm2/' + service);
    const data = await res.json();
    const el = document.getElementById(service + '-log');
    document.getElementById(service + '-count').textContent = data.length;
    if (!data.length) { el.innerHTML = '<div class="empty">No logs yet</div>'; return; }
    el.innerHTML = data.map(line => {
      const cls = colorLine(line);
      return \`<div class="log-line \${cls}">\${line.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>\`;
    }).join('');
  } catch(e) { console.error(e); }
}

async function refresh() {
  await Promise.all([
    loadNginx(),
    loadPm2('superapp'),
    loadPm2('coffee'),
    loadPm2('miniapp'),
  ]);
}

async function clearNginx() {
  await fetch(BASE + '/serverDashboard/api/nginx/clear', { method: 'POST' });
  await loadNginx();
}

async function flushPm2(svc) {
  await fetch(BASE + '/serverDashboard/api/pm2/' + svc + '/flush', { method: 'POST' });
  setTimeout(() => loadPm2(svc), 500);
}

async function clearAll() {
  await clearNginx();
  await Promise.all(['superapp','coffee','miniapp'].map(s => flushPm2(s)));
}

// Auto refresh every 3 seconds
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`);
  res.end();
});

module.exports = router;