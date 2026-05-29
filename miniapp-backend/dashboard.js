// dashboard.js — miniapp-backend
// HTML is in dashboard.html — keeps JS clean, no escaping issues

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const { readLogs, clearLogs } = require("./logger");

const router   = express.Router();
const HTML_FILE = path.join(__dirname, "dashboard.html");

router.get("/logs/data", (req, res) => {
  const logs  = readLogs();
  const after = req.query.after;
  if (!after) return res.json({ logs: logs.slice(0, 100), total: logs.length });
  const idx = logs.findIndex(l => l.id === after);
  if (idx <= 0) return res.json({ logs: [], total: logs.length });
  return res.json({ logs: logs.slice(0, idx), total: logs.length });
});

router.post("/logs/clear", (req, res) => {
  clearLogs();
  return res.json({ ok: true });
});

router.get("/dashboard", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(fs.readFileSync(HTML_FILE, "utf8"));
});

module.exports = router;
