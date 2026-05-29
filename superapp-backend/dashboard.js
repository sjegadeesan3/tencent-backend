// dashboard.js — dashboard routes for superapp-backend
// Mounts: GET /dashboard, GET /logs/data, POST /logs/clear
// NOTE: Browser fetch uses /superapp/logs/* (nginx prefix)
//       Express routes use /logs/* (nginx strips /superapp before forwarding)

const express = require("express");
const { readLogs, clearLogs } = require("./logger");

const router = express.Router();

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
  res.send(html());
});

function html() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SuperApp Backend — Dashboard</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
header { background: #16213e; border-bottom: 1px solid #0f3460; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.logo { font-size: 14px; font-weight: 600; color: #00b4d8; }
.header-right { display: flex; align-items: center; gap: 12px; }
.dot { width: 8px; height: 8px; background: #4caf50; border-radius: 50%; animation: pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
.badge { font-size: 12px; background: #0f3460; color: #88aaff; padding: 3px 10px; border-radius: 12px; }
.status-txt { font-size: 12px; color: #888; }
button { font-size: 12px; background: transparent; padding: 4px 12px; border-radius: 4px; cursor: pointer; }
#btn-pause { border: 1px solid #888; color: #888; }
#btn-pause.active { border-color: #ffaa00; color: #ffaa00; }
#btn-clear { border: 1px solid #00b4d8; color: #00b4d8; }
#btn-clear:hover { background: #00b4d822; }
.main { display: flex; flex: 1; overflow: hidden; }
.left { width: 340px; flex-shrink: 0; border-right: 1px solid #0f3460; display: flex; flex-direction: column; }
.filter-bar { padding: 8px 10px; background: #16213e; border-bottom: 1px solid #0f3460; flex-shrink: 0; }
.filter-bar input { width: 100%; background: #1a1a2e; border: 1px solid #0f3460; color: #e0e0e0; padding: 5px 8px; border-radius: 4px; font-size: 12px; }
.filter-bar input::placeholder { color: #555; }
#req-list { flex: 1; overflow-y: auto; }
.req-item { padding: 10px 12px; border-bottom: 1px solid #0f346066; cursor: pointer; display: flex; align-items: center; gap: 8px; }
.req-item:hover { background: #16213e; }
.req-item.selected { background: #0f3460; border-left: 3px solid #00b4d8; }
.req-item.flash { animation: fl 0.5s ease; }
@keyframes fl { from{background:#1a3a2e}to{background:transparent} }
.method { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px; min-width: 40px; text-align: center; }
.GET    { background:#0d47a1; color:#90caf9; }
.POST   { background:#1b5e20; color:#a5d6a7; }
.DELETE { background:#b71c1c; color:#ef9a9a; }
.PUT    { background:#4a148c; color:#ce93d8; }
.req-info { flex:1; overflow:hidden; }
.req-path { font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.req-time { font-size:10px; color:#666; margin-top:2px; }
.req-meta { text-align:right; flex-shrink:0; }
.sc { font-size:12px; font-weight:600; }
.sc.ok  { color:#4caf50; }
.sc.err { color:#e94560; }
.sc.pend{ color:#888; }
.dur { font-size:10px; color:#666; margin-top:2px; }
.right { flex:1; overflow-y:auto; }
.empty { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#444; gap:8px; font-size:13px; }
.detail { padding:16px; }
.dh { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
.dpath { font-size:15px; font-weight:500; }
.dmeta { font-size:12px; color:#888; }
.tabs { display:flex; border-bottom:1px solid #0f3460; margin-bottom:12px; }
.tab { padding:7px 16px; font-size:12px; cursor:pointer; color:#888; border-bottom:2px solid transparent; }
.tab.on { color:#00b4d8; border-bottom-color:#00b4d8; }
.tc { display:none; }
.tc.on { display:block; }
.slabel { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:.8px; margin-bottom:6px; }
pre { background:#16213e; border:1px solid #0f3460; border-radius:4px; padding:10px 12px; font-size:12px; line-height:1.6; color:#c0d0e0; overflow-x:auto; white-space:pre-wrap; word-break:break-all; }
table.kv { width:100%; font-size:12px; border-collapse:collapse; }
table.kv td { padding:4px 8px; border-bottom:1px solid #0f346033; vertical-align:top; word-break:break-all; }
table.kv td:first-child { color:#88aaff; width:42%; }
.none { color:#555; font-size:12px; font-style:italic; padding:8px 0; }
::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:#1a1a2e}::-webkit-scrollbar-thumb{background:#0f3460;border-radius:2px}
</style>
</head>
<body>
<header>
  <span class="logo">SuperApp Backend — Request Log</span>
  <div class="header-right">
    <span class="dot" id="dot"></span>
    <span class="status-txt" id="stxt">live</span>
    <span class="badge" id="badge">0 requests</span>
    <button id="btn-pause" onclick="togglePause()">Pause</button>
    <button id="btn-clear" onclick="clearAll()">Clear</button>
  </div>
</header>
<div class="main">
  <div class="left">
    <div class="filter-bar"><input id="filter" placeholder="Filter path or method…" oninput="render()"></div>
    <div id="req-list"></div>
  </div>
  <div class="right" id="right">
    <div class="empty"><span style="font-size:36px">◎</span><span>Waiting for requests…</span><span style="font-size:12px;color:#555">Select a request from the left</span></div>
  </div>
</div>
<script>
let logs=[], sel=null, lastId=null, paused=false;

// Browser fetch uses /superapp prefix — nginx forwards to Express which sees /logs/*
const DATA_URL  = '/superapp/logs/data';
const CLEAR_URL = '/superapp/logs/clear';

function togglePause(){
  paused=!paused;
  const b=document.getElementById('btn-pause');
  b.textContent=paused?'Resume':'Pause'; b.classList.toggle('active',paused);
  document.getElementById('dot').style.background=paused?'#ffaa00':'#4caf50';
  document.getElementById('stxt').textContent=paused?'paused':'live';
  if(!paused) poll();
}

async function clearAll(){
  if(!confirm('Clear all logs?')) return;
  await fetch(CLEAR_URL,{method:'POST'});
  logs=[]; lastId=null; sel=null; render();
  document.getElementById('right').innerHTML='<div class="empty"><span style="font-size:36px">◎</span><span>Logs cleared</span></div>';
  document.getElementById('badge').textContent='0 requests';
}

async function poll(){
  if(paused) return;
  try{
    const url = lastId ? DATA_URL+'?after='+encodeURIComponent(lastId) : DATA_URL;
    const r=await fetch(url);
    const d=await r.json();
    if(d.logs&&d.logs.length){
      logs=[...d.logs,...logs].slice(0,500);
      lastId=logs[0]?.id||null;
      render(true);
      document.getElementById('badge').textContent=d.total+' requests';
    }
    document.getElementById('dot').style.background='#4caf50';
    document.getElementById('stxt').textContent='live';
  }catch{
    document.getElementById('dot').style.background='#e94560';
    document.getElementById('stxt').textContent='error';
  }
  setTimeout(poll,3000);
}

function render(flash){
  const q=document.getElementById('filter').value.toLowerCase();
  const f=logs.filter(l=>!q||l.path.toLowerCase().includes(q)||l.method.toLowerCase().includes(q));
  document.getElementById('req-list').innerHTML=f.map((l,i)=>{
    const sc=l.status?(l.status<400?'ok':'err'):'pend';
    return '<div class="req-item'+(l.id===sel?' selected':'')+(flash&&i===0&&l.id!==sel?' flash':'')+'" onclick="pick(\''+l.id+'\')">'+
      '<span class="method '+l.method+'">'+l.method+'</span>'+
      '<div class="req-info"><div class="req-path">'+l.path+'</div><div class="req-time">'+new Date(l.time).toLocaleTimeString()+'</div></div>'+
      '<div class="req-meta"><div class="sc '+sc+'">'+(l.status||'…')+'</div><div class="dur">'+(l.duration?l.duration+'ms':'')+'</div></div>'+
      '</div>';
  }).join('');
}

function pick(id){
  sel=id; render();
  const l=logs.find(x=>x.id===id); if(!l) return;
  const sc=l.status?(l.status<400?'ok':'err'):'pend';
  document.getElementById('right').innerHTML=
    '<div class="detail">'+
    '<div class="dh"><span class="method '+l.method+'">'+l.method+'</span><span class="dpath">'+l.path+'</span><span class="sc '+sc+'">'+l.status+'</span><span class="dmeta">'+(l.duration?l.duration+'ms · ':'')+new Date(l.time).toLocaleString()+'</span></div>'+
    '<div class="tabs">'+
      '<div class="tab on" onclick="tab(this,\'s\')">Summary</div>'+
      '<div class="tab" onclick="tab(this,\'req\')">Request</div>'+
      '<div class="tab" onclick="tab(this,\'res\')">Response</div>'+
      '<div class="tab" onclick="tab(this,\'hdr\')">Headers</div>'+
    '</div>'+
    '<div class="tc on" id="ts">'+
      '<div class="slabel">Details</div>'+
      '<table class="kv">'+
        '<tr><td>Method</td><td>'+l.method+'</td></tr>'+
        '<tr><td>Path</td><td>'+l.path+'</td></tr>'+
        '<tr><td>Status</td><td class="sc '+sc+'">'+l.status+'</td></tr>'+
        '<tr><td>Duration</td><td>'+(l.duration?l.duration+'ms':'-')+'</td></tr>'+
        '<tr><td>Time</td><td>'+new Date(l.time).toLocaleString()+'</td></tr>'+
        '<tr><td>IP</td><td>'+(l.ip||'-')+'</td></tr>'+
      '</table>'+
    '</div>'+
    '<div class="tc" id="treq"><div class="slabel">Request body</div>'+
      (Object.keys(l.reqBody||{}).length?'<pre>'+JSON.stringify(l.reqBody,null,2)+'</pre>':'<div class="none">No body</div>')+
    '</div>'+
    '<div class="tc" id="tres"><div class="slabel">Response body</div>'+
      (l.resBody?'<pre>'+JSON.stringify(l.resBody,null,2)+'</pre>':'<div class="none">No response captured</div>')+
    '</div>'+
    '<div class="tc" id="thdr"><div class="slabel">Request headers</div>'+
      '<table class="kv">'+Object.entries(l.reqHeaders||{}).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('')+'</table>'+
    '</div>'+
    '</div>';
}

function tab(el,id){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.tc').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('t'+id).classList.add('on');
}

// Initial load
fetch(DATA_URL).then(r=>r.json()).then(d=>{
  logs=d.logs||[]; lastId=logs[0]?.id||null;
  document.getElementById('badge').textContent=(d.total||0)+' requests';
  render(); setTimeout(poll,3000);
});
</script>
</body>
</html>`;
}

module.exports = router;
