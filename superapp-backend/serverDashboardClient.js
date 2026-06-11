// serverDashboard client.js
// Served at /superapp/serverDashboard/client.js

var BASE = '/superapp/serverDashboard';

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
  return t ? t.split(':').slice(1).join(':').split(' ')[0] : '';
}

function lineClass(line) {
  if (line.indexOf('[ERROR]') >= 0 || line.indexOf('Error') >= 0) return 'l-err';
  if (line.indexOf('SUCCESS') >= 0 || line.indexOf('✅') >= 0) return 'l-ok';
  if (line.indexOf('[SUPERAPP]') >= 0 || line.indexOf('[MINIAPP]') >= 0 || line.indexOf('[COFFEE]') >= 0) return 'l-inf';
  if (line.indexOf('WARN') >= 0) return 'l-wrn';
  return '';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderNginx(data) {
  var el = document.getElementById('nginx-panel');
  document.getElementById('n-count').textContent = data.length;
  if (!data.length) { el.innerHTML = '<div class="empty">No requests yet</div>'; return; }
  var html = '';
  for (var i = 0; i < data.length; i++) {
    var e = data[i];
    var ip = ipInfo(e.ip);
    html += '<div class="nginx-row">';
    html += '<span class="ip-tag" style="background:' + ip.color + '22;color:' + ip.color + '">' + ip.label + '</span>';
    html += '<span class="method ' + e.method + '">' + esc(e.method) + '</span>';
    html += '<span class="time-s">' + formatTime(e.time) + '</span>';
    html += '<span class="path" title="' + esc(e.path) + '">' + esc(e.path) + '</span>';
    html += '<span class="status ' + statusClass(e.status) + '">' + e.status + '</span>';
    html += '</div>';
  }
  el.innerHTML = html;
}

function renderLogs(panelId, countId, data) {
  var el = document.getElementById(panelId);
  document.getElementById(countId).textContent = data.length;
  if (!data.length) { el.innerHTML = '<div class="empty">No logs yet</div>'; return; }
  var html = '';
  for (var i = 0; i < data.length; i++) {
    var cls = lineClass(data[i]);
    html += '<div class="log-line ' + cls + '">' + esc(data[i]) + '</div>';
  }
  el.innerHTML = html;
}

function loadNginx() {
  fetch(BASE + '/api/nginx')
    .then(function(r){ return r.json(); })
    .then(renderNginx)
    .catch(function(e){ console.error('nginx', e); });
}

function loadPm2(svc, panelId, countId) {
  fetch(BASE + '/api/pm2/' + svc)
    .then(function(r){ return r.json(); })
    .then(function(d){ renderLogs(panelId, countId, d); })
    .catch(function(e){ console.error(svc, e); });
}

function loadAll() {
  loadNginx();
  loadPm2('superapp', 'sa-panel', 'sa-count');
  loadPm2('coffee',   'cf-panel', 'cf-count');
  loadPm2('miniapp',  'ec-panel', 'ec-count');
}

function clearNginx() {
  fetch(BASE + '/api/nginx/clear', { method: 'POST' })
    .then(function(){ loadNginx(); });
}

function flushLog(svc) {
  fetch(BASE + '/api/pm2/' + svc + '/flush', { method: 'POST' })
    .then(function(){
      setTimeout(function(){
        if (svc === 'superapp') loadPm2('superapp', 'sa-panel', 'sa-count');
        else if (svc === 'coffee') loadPm2('coffee', 'cf-panel', 'cf-count');
        else loadPm2('miniapp', 'ec-panel', 'ec-count');
      }, 500);
    });
}

function clearAll() {
  clearNginx();
  flushLog('superapp');
  flushLog('coffee');
  flushLog('miniapp');
}

function copyAll() {
  var btn = document.getElementById('copyBtn');
  Promise.all([
    fetch(BASE + '/api/nginx').then(function(r){ return r.json(); }),
    fetch(BASE + '/api/pm2/superapp').then(function(r){ return r.json(); }),
    fetch(BASE + '/api/pm2/coffee').then(function(r){ return r.json(); }),
    fetch(BASE + '/api/pm2/miniapp').then(function(r){ return r.json(); })
  ]).then(function(results) {
    var nginx = results[0], superapp = results[1], coffee = results[2], miniapp = results[3];
    var lines = [
      '===========================================',
      '  UOB TMRW Server Dashboard Log Dump',
      '  ' + new Date().toISOString(),
      '===========================================',
      '',
      '-- NGINX ACCESS LOG -----------------------'
    ];
    for (var i = 0; i < nginx.length; i++) {
      var e = nginx[i];
      lines.push('[' + e.time + '] ' + e.ip + ' ' + e.method + ' ' + e.path + ' ' + e.status);
    }
    lines.push('');
    lines.push('-- SUPERAPP BACKEND -------------------');
    for (var i = 0; i < superapp.length; i++) lines.push(superapp[i]);
    lines.push('');
    lines.push('-- COFFEE MINIAPP BACKEND -------------');
    for (var i = 0; i < coffee.length; i++) lines.push(coffee[i]);
    lines.push('');
    lines.push('-- ECOMMERCE MINIAPP BACKEND ----------');
    for (var i = 0; i < miniapp.length; i++) lines.push(miniapp[i]);

    navigator.clipboard.writeText(lines.join('\n')).then(function() {
      btn.textContent = 'Copied!';
      btn.className = 'btn success';
      setTimeout(function() {
        btn.textContent = 'Copy All Logs';
        btn.className = 'btn';
      }, 2000);
    });
  }).catch(function(e) {
    console.error(e);
    btn.textContent = 'Failed';
    setTimeout(function() { btn.textContent = 'Copy All Logs'; }, 2000);
  });
}

// Auto refresh every 3 seconds
loadAll();
setInterval(loadAll, 3000);
