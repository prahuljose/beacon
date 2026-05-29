/* Beacon — client logic  (plain script, no ES modules) */

var POLL_MS       = 15000;
var DEFAULT_SID   = 'e3c2c54c-c872-4fdb-8147-99381e685cff';
var LAST          = { liveW:0, today:0, month:0, total:0, cap:0 };
var pacChart      = null;
var pollTimer     = null;

/* ── credentials ──────────────────────────────────────────────────────────── */

function getCreds() {
  return {
    email:     localStorage.getItem('b_email')    || '',
    password:  localStorage.getItem('b_pass')     || '',
    stationId: localStorage.getItem('b_sid')      || DEFAULT_SID,
  };
}
function saveCreds(e, p, s) {
  localStorage.setItem('b_email', e);
  localStorage.setItem('b_pass',  p);
  localStorage.setItem('b_sid',   s || DEFAULT_SID);
}
function clearCreds() {
  ['b_email','b_pass','b_sid'].forEach(function(k){ localStorage.removeItem(k); });
}
function hasCreds() {
  return !!(localStorage.getItem('b_email') && localStorage.getItem('b_pass'));
}

/* ── view switching ──────────────────────────────────────────────────────── */

function showDashboard() {
  document.getElementById('loginView').style.display    = 'none';
  var d = document.getElementById('dashboardView');
  d.style.display  = 'block';
  d.style.position = '';
  d.style.opacity  = '1';
}
function showLogin() {
  stopPolling();
  document.getElementById('dashboardView').style.display = 'none';
  document.getElementById('loginView').style.display     = 'flex';
}

/* ── network ─────────────────────────────────────────────────────────────── */

function apiFetch(url, callback) {
  var c = getCreds();
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.setRequestHeader('X-Sems-Email',      c.email);
  xhr.setRequestHeader('X-Sems-Password',   c.password);
  xhr.setRequestHeader('X-Sems-Station-Id', c.stationId);
  xhr.onload = function() {
    try {
      var body = JSON.parse(xhr.responseText);
      if (xhr.status === 401) {
        callback(new Error(body.error || 'Unauthorised'), null, 401);
      } else if (xhr.status >= 300) {
        callback(new Error(body.error || 'HTTP ' + xhr.status), null, xhr.status);
      } else {
        callback(null, body);
      }
    } catch(e) {
      callback(new Error('Bad response'), null);
    }
  };
  xhr.onerror = function() { callback(new Error('Network error'), null); };
  xhr.send();
}

/* ── login form ──────────────────────────────────────────────────────────── */

function initLogin() {
  var form    = document.getElementById('loginForm');
  var errBox  = document.getElementById('loginError');
  var btn     = document.getElementById('loginBtn');
  var btnTxt  = document.getElementById('loginBtnText');
  var spinner = document.getElementById('loginSpinner');

  /* pre-fill */
  var c = getCreds();
  if (c.email) document.getElementById('lEmail').value     = c.email;
  document.getElementById('lStationId').value = c.stationId;

  /* password visibility toggle */
  document.getElementById('togglePwd').addEventListener('click', function() {
    var inp  = document.getElementById('lPassword');
    var icon = document.getElementById('eyeIcon');
    if (inp.type === 'password') {
      inp.type = 'text';
      icon.innerHTML =
        '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8' +
        'a18.45 18.45 0 0 1 5.06-5.94"/>' +
        '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8' +
        'a18.5 18.5 0 0 1-2.16 3.19"/>' +
        '<line x1="1" y1="1" x2="23" y2="23"/>';
    } else {
      inp.type = 'password';
      icon.innerHTML =
        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
        '<circle cx="12" cy="12" r="3"/>';
    }
  });

  /* advanced toggle */
  document.getElementById('advancedToggle').addEventListener('click', function() {
    var sec     = document.getElementById('advancedSection');
    var chevron = document.getElementById('advChevron');
    var open    = sec.style.display === 'block';
    sec.style.display    = open ? 'none' : 'block';
    chevron.style.transform = open ? '' : 'rotate(90deg)';
  });

  /* form submit */
  form.addEventListener('submit', function(e) {
    e.preventDefault();   /* ← must be first, before any async */
    e.stopPropagation();

    var email     = document.getElementById('lEmail').value.trim();
    var password  = document.getElementById('lPassword').value;
    var stationId = document.getElementById('lStationId').value.trim() || DEFAULT_SID;

    if (!email || !password) {
      showErr('Please enter your email and password.');
      return;
    }

    errBox.style.display = 'none';
    btn.disabled         = true;
    btnTxt.textContent   = 'Signing in…';
    spinner.style.display = 'inline-block';

    saveCreds(email, password, stationId);

    apiFetch('/api/monitor', function(err, data, status) {
      if (err) {
        clearCreds();
        showErr(
          (status === 401)
            ? 'Incorrect email or password. Please try again.'
            : 'Error: ' + err.message
        );
        btn.disabled          = false;
        btnTxt.textContent    = 'Sign in';
        spinner.style.display = 'none';
        return;
      }
      showDashboard();
      renderAll(data, null);
      apiFetch('/api/pac', function(e2, pac) {
        if (!e2 && pac) renderPowerCurve(pac);
      });
      startPolling();
    });

    function showErr(msg) {
      errBox.textContent   = msg;
      errBox.style.display = 'block';
    }
  });
}

/* ── sign-out ─────────────────────────────────────────────────────────────── */

function initSignOut() {
  document.getElementById('signOutBtn').addEventListener('click', function() {
    clearCreds();
    LAST = { liveW:0, today:0, month:0, total:0, cap:0 };
    if (pacChart) {
      pacChart.data.labels = [];
      pacChart.data.datasets[0].data = [];
      pacChart.update('none');
    }
    showLogin();
  });
}

/* ── utilities ───────────────────────────────────────────────────────────── */

function fmt(n, d) {
  if (!isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d, maximumFractionDigits: d
  });
}
function fmtTime(d) {
  return d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
}
function parseGwTime(s) {
  if (!s) return null;
  var pts = s.trim().split(' ');
  var dp  = pts[0], tp = pts[1] || '00:00:00';
  var t   = tp.split(':');
  var hh=+t[0]||0, mm=+t[1]||0, ss=+t[2]||0;
  try {
    if (dp.indexOf('-') > -1) {
      var d = dp.split('-'); return new Date(+d[0],+d[1]-1,+d[2],hh,mm,ss);
    }
    if (dp.indexOf('/') > -1) {
      var d = dp.split('/'); return new Date(+d[2],+d[0]-1,+d[1],hh,mm,ss);
    }
  } catch(e){}
  return null;
}
function sameDay(a,b) {
  return a.getFullYear()===b.getFullYear() &&
         a.getMonth()===b.getMonth() &&
         a.getDate()===b.getDate();
}
function isStale(monitor) {
  var s = (monitor.inverter||[])[0];
  var t = parseGwTime(s && s.d && s.d.last_refresh_time);
  if (!t) return false;
  var n = new Date();
  return new Date(t.getFullYear(),t.getMonth(),t.getDate()) <
         new Date(n.getFullYear(),n.getMonth(),n.getDate());
}
function animate(from, to, ms, fn) {
  var start = performance.now();
  function tick(now) {
    var t = Math.min(1,(now-start)/ms);
    var e = 1-Math.pow(1-t,3);
    fn(from+(to-from)*e);
    if (t<1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ── renderers ───────────────────────────────────────────────────────────── */

function renderHeader(monitor) {
  var info = monitor.info || {};
  document.getElementById('stationName').textContent    = info.stationname || 'Solar';
  document.getElementById('stationAddress').textContent = info.address     || '';

  var s = info.status;
  var color = s===1||s===0 ? '#10B981' : s===-1 ? '#8B9CB5' : '#EF4444';
  var label = s===1||s===0 ? 'Online'  : s===-1 ? 'Wait Mode' : 'Fault';
  var badge = document.getElementById('statusBadge');
  badge.innerHTML =
    '<span class="pulse-dot" style="display:inline-block;width:6px;height:6px;' +
    'border-radius:50%;background:'+color+'"></span>' +
    '<span style="color:'+color+'"> '+label+'</span>';
  badge.style.borderColor = color+'55';
  badge.style.background  = color+'1a';
  document.getElementById('lastRefreshed').textContent = 'Refreshed '+fmtTime(new Date());
}

function renderLive(monitor) {
  var pac   = +(monitor.kpi && monitor.kpi.pac) || 0;
  var capKw = +(monitor.info && monitor.info.capacity) || 0;

  animate(LAST.liveW, pac, 700, function(v) {
    document.getElementById('liveWatts').textContent = Math.round(v).toLocaleString()+' W';
    document.getElementById('liveWatts').style.color = pac>0 ? '#F59E0B' : '#8B9CB5';
  });
  LAST.liveW = pac;
  document.getElementById('liveCaption').textContent =
    pac > 0 ? 'Currently generating'
    : (((monitor.inverter||[])[0]||{}).d||{}).work_mode || 'Waiting for sunrise';

  var pct = capKw>0 ? Math.min(100,(pac/(capKw*1000))*100) : 0;
  animate(LAST.cap, pct, 900, function(v) {
    document.getElementById('capacityBar').style.width = v.toFixed(1)+'%';
    document.getElementById('capacityPct').textContent = Math.round(v)+'%';
  });
  LAST.cap = pct;
}

function renderKpis(monitor, stale) {
  var kpi   = monitor.kpi || {};
  var today = stale ? 0 : (+(kpi.power)||0);
  var month = +(kpi.month_generation)||0;
  var total = +(kpi.total_power)||0;

  animate(LAST.today, today, 700, function(v){
    document.getElementById('kpiToday').textContent = fmt(v, today>=100?0:1);
  });
  LAST.today = today;

  animate(LAST.month, month, 700, function(v){
    document.getElementById('kpiMonth').textContent = fmt(v, month>=1000?0:1);
  });
  LAST.month = month;

  var mwh = total>=1000, tv = mwh ? total/1000 : total;
  animate(LAST.total, tv, 700, function(v){
    document.getElementById('kpiTotal').textContent = fmt(v, tv>=100?0:1);
  });
  LAST.total = tv;
  document.getElementById('kpiTotalUnit').textContent = mwh ? 'MWh' : 'kWh';
}

function renderEnv(monitor) {
  var e = monitor.hjgx || {};
  document.getElementById('co2').textContent   = fmt(+(e.co2 )||0, 2);
  document.getElementById('trees').textContent = fmt(+(e.tree)||0, 0);
  document.getElementById('coal').textContent  = fmt(+(e.coal)||0, 0);
}

/* ── chart ───────────────────────────────────────────────────────────────── */

function buildChart() {
  pacChart = new Chart(document.getElementById('pacChart'), {
    type: 'line',
    data: { labels:[], datasets:[{
      data:[], borderColor:'#F59E0B',
      backgroundColor: function(c) {
        var ca = c.chart.chartArea;
        if (!ca) return 'rgba(245,158,11,.18)';
        var g = c.chart.ctx.createLinearGradient(0,ca.top,0,ca.bottom);
        g.addColorStop(0,'rgba(245,158,11,.35)');
        g.addColorStop(1,'rgba(245,158,11,.00)');
        return g;
      },
      borderWidth:2, fill:true, tension:0.35,
      pointRadius:0, pointHoverRadius:4,
      pointHoverBackgroundColor:'#F59E0B',
    }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false },
      plugins:{
        legend:{ display:false },
        tooltip:{
          backgroundColor:'#1A2235', borderColor:'#1E2D45', borderWidth:1,
          titleColor:'#FFF', bodyColor:'#F59E0B', padding:10, displayColors:false,
          callbacks:{
            title:function(i){ return i[0]&&i[0].label||''; },
            label:function(i){ return Math.round(i.parsed.y).toLocaleString()+' W'; },
          },
        },
      },
      scales:{
        x:{ grid:{display:false},
            ticks:{color:'#8B9CB5',font:{size:10},maxRotation:0,autoSkipPadding:16} },
        y:{ beginAtZero:true, grid:{color:'rgba(30,45,69,.6)'},
            ticks:{color:'#8B9CB5',font:{size:10},
              callback:function(v){ return v>=1000?(v/1000).toFixed(1)+'k':v; }} },
      },
    },
  });
}

function renderPowerCurve(pac) {
  if (!pacChart) buildChart();
  var samples = pac.samples || [];
  var pts = samples.map(function(s){
    return { t:parseGwTime(s.date), pac:+(s.pac)||0 };
  }).filter(function(p){ return !!p.t; });

  pacChart.data.labels = pts.map(function(p){ return fmtTime(p.t); });
  pacChart.data.datasets[0].data = pts.map(function(p){ return p.pac; });
  pacChart.update('none');

  var now = new Date();
  var d   = parseGwTime((pac.date||'')+' 00:00:00');
  document.getElementById('pacSubtitle').textContent =
    (d && sameDay(d,now)) ? 'Today' : pac.date||'';

  var peakEl  = document.getElementById('peakBadge');
  var totalEl = document.getElementById('totalBadge');

  if (!pts.length) {
    peakEl.style.display = totalEl.style.display = 'none';
    return;
  }
  var peak = pts.reduce(function(m,p){ return p.pac>m?p.pac:m; }, 0);
  peakEl.textContent = 'Peak '+Math.round(peak).toLocaleString()+' W';
  peakEl.style.display = 'inline-flex';

  var wh = 0;
  for (var i=0;i<pts.length-1;i++) {
    wh += pts[i].pac * (pts[i+1].t.getTime()-pts[i].t.getTime()) / 3600000;
  }
  var kwh = wh/1000;
  if (kwh > 0) {
    totalEl.textContent = 'Total '+kwh.toFixed(2)+' kWh';
    totalEl.style.display = 'inline-flex';
  } else {
    totalEl.style.display = 'none';
  }
}

function renderAll(monitor, pac) {
  var stale = isStale(monitor);
  var m     = stale ? Object.assign({},monitor,{kpi:Object.assign({},monitor.kpi,{pac:0})}) : monitor;
  renderHeader(monitor);
  renderLive(m);
  renderKpis(monitor, stale);
  renderEnv(monitor);
  if (pac) renderPowerCurve(pac);
}

/* ── polling ─────────────────────────────────────────────────────────────── */

function refresh() {
  document.getElementById('errorBox').style.display = 'none';
  apiFetch('/api/monitor', function(err, monitor, status) {
    if (err) {
      if (status===401) { clearCreds(); showLogin(); }
      else {
        document.getElementById('errorBox').textContent = '⚠ '+err.message;
        document.getElementById('errorBox').style.display = 'block';
      }
      return;
    }
    renderAll(monitor, null);
    apiFetch('/api/pac', function(e2, pac) {
      if (!e2 && pac) renderPowerCurve(pac);
    });
  });
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener('visibilitychange', function() {
  if (document.hidden) stopPolling();
  else if (hasCreds()) { refresh(); startPolling(); }
});

/* ── boot ────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', function() {
  initLogin();
  initSignOut();

  if (hasCreds()) {
    showDashboard();
    refresh();
    startPolling();
  } else {
    showLogin();
  }
});
