// dashboard.js — miniapp-backend
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
<title>MiniApp Backend - Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',monospace;background:#1a1a2e;color:#e0e0e0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{background:#16213e;border-bottom:1px solid #0f3460;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.logo{font-size:14px;font-weight:600;color:#e94560}
.hr{display:flex;align-items:center;gap:12px}
.dot{width:8px;height:8px;background:#4caf50;border-radius:50%;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.stxt{font-size:12px;color:#888}
.badge{font-size:12px;background:#0f3460;color:#88aaff;padding:3px 10px;border-radius:12px}
button{font-size:12px;background:transparent;padding:4px 12px;border-radius:4px;cursor:pointer}
#btnP{border:1px solid #888;color:#888}
#btnP.on{border-color:#ffaa00;color:#ffaa00}
#btnC{border:1px solid #e94560;color:#e94560}
#btnC:hover{background:#e9456022}
.main{display:flex;flex:1;overflow:hidden}
.left{width:340px;flex-shrink:0;border-right:1px solid #0f3460;display:flex;flex-direction:column}
.fb{padding:8px 10px;background:#16213e;border-bottom:1px solid #0f3460;flex-shrink:0}
.fb input{width:100%;background:#1a1a2e;border:1px solid #0f3460;color:#e0e0e0;padding:5px 8px;border-radius:4px;font-size:12px}
.fb input::placeholder{color:#555}
#list{flex:1;overflow-y:auto}
.ri{padding:10px 12px;border-bottom:1px solid #0f346066;cursor:pointer;display:flex;align-items:center;gap:8px}
.ri:hover{background:#16213e}
.ri.sel{background:#0f3460;border-left:3px solid #e94560}
.ri.fl{animation:fla .5s ease}
@keyframes fla{from{background:#1a3a2e}to{background:transparent}}
.m{font-size:11px;font-weight:700;padding:2px 6px;border-radius:3px;min-width:40px;text-align:center}
.GET{background:#0d47a1;color:#90caf9}
.POST{background:#1b5e20;color:#a5d6a7}
.DELETE{background:#b71c1c;color:#ef9a9a}
.PUT{background:#4a148c;color:#ce93d8}
.ri-info{flex:1;overflow:hidden}
.rp{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt{font-size:10px;color:#666;margin-top:2px}
.rm{text-align:right;flex-shrink:0}
.sc{font-size:12px;font-weight:600}
.ok{color:#4caf50}
.er{color:#e94560}
.pn{color:#888}
.dr{font-size:10px;color:#666;margin-top:2px}
.right{flex:1;overflow-y:auto}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#444;gap:8px;font-size:13px}
.det{padding:16px}
.dh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.dp{font-size:15px;font-weight:500}
.dm{font-size:12px;color:#888}
.tabs{display:flex;border-bottom:1px solid #0f3460;margin-bottom:12px}
.tab{padding:7px 16px;font-size:12px;cursor:pointer;color:#888;border-bottom:2px solid transparent}
.tab.on{color:#e94560;border-bottom-color:#e94560}
.tc{display:none}
.tc.on{display:block}
.sl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
pre{background:#16213e;border:1px solid #0f3460;border-radius:4px;padding:10px 12px;font-size:12px;line-height:1.6;color:#c0d0e0;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
table.kv{width:100%;font-size:12px;border-collapse:collapse}
table.kv td{padding:4px 8px;border-bottom:1px solid #0f346033;vertical-align:top;word-break:break-all}
table.kv td:first-child{color:#88aaff;width:42%}
.none{color:#555;font-size:12px;font-style:italic;padding:8px 0}
::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:#1a1a2e}::-webkit-scrollbar-thumb{background:#0f3460;border-radius:2px}
</style>
</head>
<body>
<header>
  <span class="logo">MiniApp Backend &mdash; Request Log</span>
  <div class="hr">
    <span class="dot" id="dot"></span>
    <span class="stxt" id="stxt">live</span>
    <span class="badge" id="badge">0 requests</span>
    <button id="btnP" onclick="togglePause()">Pause</button>
    <button id="btnC" onclick="clearAll()">Clear</button>
  </div>
</header>
<div class="main">
  <div class="left">
    <div class="fb"><input id="fi" placeholder="Filter path or method..." oninput="render()"></div>
    <div id="list"></div>
  </div>
  <div class="right" id="right">
    <div class="empty">
      <span style="font-size:36px">&#9711;</span>
      <span>Waiting for requests...</span>
      <span style="font-size:12px;color:#555">Select a request from the left</span>
    </div>
  </div>
</div>
<script>
var logs=[], sel=null, lastId=null, paused=false;
var DATA='/miniapp/logs/data', CLR='/miniapp/logs/clear';

function togglePause(){
  paused=!paused;
  var b=document.getElementById('btnP');
  b.textContent=paused?'Resume':'Pause';
  b.classList.toggle('on',paused);
  document.getElementById('dot').style.background=paused?'#ffaa00':'#4caf50';
  document.getElementById('stxt').textContent=paused?'paused':'live';
  if(!paused) poll();
}

function clearAll(){
  if(!confirm('Clear all logs?')) return;
  fetch(CLR,{method:'POST'}).then(function(){
    logs=[]; lastId=null; sel=null; render();
    document.getElementById('right').innerHTML='<div class="empty"><span style="font-size:36px">&#9711;</span><span>Logs cleared</span></div>';
    document.getElementById('badge').textContent='0 requests';
  });
}

function poll(){
  if(paused) return;
  var url=lastId?DATA+'?after='+encodeURIComponent(lastId):DATA;
  fetch(url).then(function(r){return r.json();}).then(function(d){
    if(d.logs&&d.logs.length){
      logs=d.logs.concat(logs).slice(0,500);
      lastId=logs[0]?logs[0].id:null;
      render(true);
      document.getElementById('badge').textContent=d.total+' requests';
    }
    document.getElementById('dot').style.background='#4caf50';
    document.getElementById('stxt').textContent='live';
  }).catch(function(){
    document.getElementById('dot').style.background='#e94560';
    document.getElementById('stxt').textContent='error';
  }).finally(function(){
    setTimeout(poll,3000);
  });
}

function render(flash){
  var q=document.getElementById('fi').value.toLowerCase();
  var f=logs.filter(function(l){return !q||l.path.toLowerCase().indexOf(q)>=0||l.method.toLowerCase().indexOf(q)>=0;});
  var html='';
  for(var i=0;i<f.length;i++){
    var l=f[i];
    var sc=l.status?(l.status<400?'ok':'er'):'pn';
    var cls='ri'+(l.id===sel?' sel':'')+(flash&&i===0&&l.id!==sel?' fl':'');
    var lid=l.id.replace(/'/g,"\\'");
    html+='<div class="'+cls+'" onclick="pick(\''+lid+'\')">';
    html+='<span class="m '+l.method+'">'+l.method+'</span>';
    html+='<div class="ri-info"><div class="rp">'+esc(l.path)+'</div><div class="rt">'+new Date(l.time).toLocaleTimeString()+'</div></div>';
    html+='<div class="rm"><div class="sc '+sc+'">'+(l.status||'...')+'</div><div class="dr">'+(l.duration?l.duration+'ms':'')+'</div></div>';
    html+='</div>';
  }
  document.getElementById('list').innerHTML=html;
}

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function pick(id){
  sel=id; render();
  var l=null;
  for(var i=0;i<logs.length;i++){if(logs[i].id===id){l=logs[i];break;}}
  if(!l) return;
  var sc=l.status?(l.status<400?'ok':'er'):'pn';
  var rb=JSON.parse(JSON.stringify(l.reqBody||{}));
  if(rb.token) rb.token=rb.token.substring(0,20)+'...';
  var html='<div class="det">';
  html+='<div class="dh"><span class="m '+l.method+'">'+l.method+'</span><span class="dp">'+esc(l.path)+'</span><span class="sc '+sc+'">'+l.status+'</span><span class="dm">'+(l.duration?l.duration+'ms &middot; ':'')+new Date(l.time).toLocaleString()+'</span></div>';
  html+='<div class="tabs"><div class="tab on" onclick="swt(this,\'s\')">Summary</div><div class="tab" onclick="swt(this,\'q\')">Request</div><div class="tab" onclick="swt(this,\'r\')">Response</div><div class="tab" onclick="swt(this,\'h\')">Headers</div></div>';
  html+='<div class="tc on" id="ts"><div class="sl">Details</div><table class="kv"><tr><td>Method</td><td>'+l.method+'</td></tr><tr><td>Path</td><td>'+esc(l.path)+'</td></tr><tr><td>Status</td><td class="sc '+sc+'">'+l.status+'</td></tr><tr><td>Duration</td><td>'+(l.duration?l.duration+'ms':'-')+'</td></tr><tr><td>Time</td><td>'+new Date(l.time).toLocaleString()+'</td></tr><tr><td>IP</td><td>'+(l.ip||'-')+'</td></tr></table></div>';
  html+='<div class="tc" id="tq"><div class="sl">Request body</div>'+(Object.keys(rb).length?'<pre>'+esc(JSON.stringify(rb,null,2))+'</pre>':'<div class="none">No body</div>')+'</div>';
  html+='<div class="tc" id="tr"><div class="sl">Response body</div>'+(l.resBody?'<pre>'+esc(JSON.stringify(l.resBody,null,2))+'</pre>':'<div class="none">No response captured</div>')+'</div>';
  var hdrRows='';
  var hdr=l.reqHeaders||{};
  for(var k in hdr){hdrRows+='<tr><td>'+esc(k)+'</td><td>'+esc(String(hdr[k]))+'</td></tr>';}
  html+='<div class="tc" id="th"><div class="sl">Request headers</div><table class="kv">'+hdrRows+'</table></div>';
  html+='</div>';
  document.getElementById('right').innerHTML=html;
}

function swt(el,id){
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i++) tabs[i].classList.remove('on');
  var tcs=document.querySelectorAll('.tc');
  for(var i=0;i<tcs.length;i++) tcs[i].classList.remove('on');
  el.classList.add('on');
  document.getElementById('t'+id).classList.add('on');
}

fetch(DATA).then(function(r){return r.json();}).then(function(d){
  logs=d.logs||[]; lastId=logs[0]?logs[0].id:null;
  document.getElementById('badge').textContent=(d.total||0)+' requests';
  render(); setTimeout(poll,3000);
});
</script>
</body>
</html>`;
}

module.exports = router;
