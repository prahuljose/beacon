// ─── Beacon — client logic ────────────────────────────────────────────────────
// State machine: LOGIN → (authenticate) → DASHBOARD (poll every 15s)

const POLL_INTERVAL_MS  = 15_000;
const DEFAULT_STATION   = 'e3c2c54c-c872-4fdb-8147-99381e685cff';
const KEY = {
  email:     'beacon_email',
  password:  'beacon_password',
  stationId: 'beacon_station_id',
};

// ─── Credential helpers ───────────────────────────────────────────────────────

const getCreds = () => ({
  email:     localStorage.getItem(KEY.email)     || '',
  password:  localStorage.getItem(KEY.password)  || '',
  stationId: localStorage.getItem(KEY.stationId) || DEFAULT_STATION,
});
const saveCreds = ({ email, password, stationId }) => {
  localStorage.setItem(KEY.email,     email);
  localStorage.setItem(KEY.password,  password);
  localStorage.setItem(KEY.stationId, stationId || DEFAULT_STATION);
};
const clearCreds = () => Object.values(KEY).forEach(k => localStorage.removeItem(k));
const hasCreds   = () => !!localStorage.getItem(KEY.email) && !!localStorage.getItem(KEY.password);

// ─── View transitions ─────────────────────────────────────────────────────────

function showDashboard() {
  document.getElementById('loginView').classList.add('view-hidden');
  const dash = document.getElementById('dashboardView');
  dash.classList.remove('view-hidden');
  dash.style.position = '';
}

function showLogin() {
  stopPolling();
  document.getElementById('dashboardView').classList.add('view-hidden');
  document.getElementById('dashboardView').style.position = 'absolute';
  document.getElementById('loginView').classList.remove('view-hidden');
}

// ─── Network ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const { email, password, stationId } = getCreds();
  const res = await fetch(url, {
    cache: 'no-store',
    headers: {
      'X-Sems-Email':      email,
      'X-Sems-Password':   password,
      'X-Sems-Station-Id': stationId,
    },
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ─── Login form ───────────────────────────────────────────────────────────────

function initLoginForm() {
  const form     = document.getElementById('loginForm');
  const errorBox = document.getElementById('loginError');
  const btn      = document.getElementById('loginBtn');
  const btnText  = document.getElementById('loginBtnText');
  const spinner  = document.getElementById('loginSpinner');

  // Pre-fill if credentials already stored (e.g. returning after a sign-out)
  const { email, stationId } = getCreds();
  if (email) document.getElementById('lEmail').value = email;
  document.getElementById('lStationId').value = stationId;

  // Toggle password visibility
  document.getElementById('togglePwd').addEventListener('click', () => {
    const inp  = document.getElementById('lPassword');
    const icon = document.getElementById('eyeIcon');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    icon.innerHTML = show
      ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8
                  a18.45 18.45 0 0 1 5.06-5.94"/>
         <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8
                  a18.5 18.5 0 0 1-2.16 3.19"/>
         <line x1="1" y1="1" x2="23" y2="23"/>`
      : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
         <circle cx="12" cy="12" r="3"/>`;
  });

  // Advanced section toggle
  const advToggle  = document.getElementById('advancedToggle');
  const advSection = document.getElementById('advancedSection');
  const advChevron = document.getElementById('advChevron');
  advToggle.addEventListener('click', () => {
    const open = !advSection.classList.contains('hidden');
    advSection.classList.toggle('hidden', open);
    advChevron.style.transform = open ? '' : 'rotate(90deg)';
  });

  // Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    btn.disabled = true;
    btnText.textContent = 'Signing in…';
    spinner.classList.remove('hidden');

    const email     = document.getElementById('lEmail').value.trim();
    const password  = document.getElementById('lPassword').value;
    const stationId = document.getElementById('lStationId').value.trim() || DEFAULT_STATION;

    try {
      saveCreds({ email, password, stationId });
      // Authenticate + load data — if this throws with 401 the creds are wrong
      const monitor = await fetchJson('/api/monitor');
      showDashboard();
      renderAll(monitor, null);
      fetchJson('/api/pac').then(pac => renderPowerCurve(pac)).catch(() => {});
      startPolling();
    } catch (err) {
      clearCreds();
      errorBox.textContent =
        err.status === 401
          ? 'Incorrect email or password. Please try again.'
          : `Error: ${err.message}`;
      errorBox.classList.remove('hidden');
      btn.disabled = false;
      btnText.textContent = 'Sign in';
      spinner.classList.add('hidden');
    }
  });
}

// ─── Sign out ─────────────────────────────────────────────────────────────────

function initSignOut() {
  document.getElementById('signOutBtn').addEventListener('click', () => {
    clearCreds();
    // Reset last-values so next login animates from 0
    Object.keys(lastValues).forEach(k => lastValues[k] = 0);
    // Clear chart
    if (pacChart) {
      pacChart.data.labels = [];
      pacChart.data.datasets[0].data = [];
      pacChart.update('none');
    }
    showLogin();
  });
}

// ─── Render helpers ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const lastValues = { liveW:0, today:0, month:0, total:0, capacity:0 };

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

function parseGoodweTime(s) {
  if (!s || typeof s !== 'string') return null;
  const [datePart, timePart = '00:00:00'] = s.trim().split(' ');
  const [hh=0, mm=0, ss=0] = timePart.split(':').map(Number);
  try {
    if (datePart.includes('-')) {
      const [y,m,d] = datePart.split('-').map(Number);
      return new Date(y, m-1, d, hh, mm, ss);
    }
    if (datePart.includes('/')) {
      const [m,d,y] = datePart.split('/').map(Number);
      return new Date(y, m-1, d, hh, mm, ss);
    }
  } catch(_) {}
  return null;
}

function isSolarStale(monitor) {
  const s = monitor?.inverter?.[0]?.d?.last_refresh_time ?? '';
  const t = parseGoodweTime(s);
  if (!t) return false;
  const n = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate())
       < new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function animateNumber(from, to, ms, onFrame) {
  const start = performance.now();
  const ease  = t => 1 - Math.pow(1-t, 3);
  (function tick(now) {
    const t = Math.min(1, (now-start)/ms);
    onFrame(from + (to-from)*ease(t));
    if (t < 1) requestAnimationFrame(tick);
  })(performance.now());
}

function fmt(n, decimals=1) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
const fmtTime = d =>
  d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });

// ─── Renderers ────────────────────────────────────────────────────────────────

function renderHeader(monitor) {
  const info = monitor.info || {};
  $('stationName').textContent    = info.stationname || 'Solar Dashboard';
  $('stationAddress').textContent = info.address     || '';

  const s = info.status;
  const [color, label] =
    s === 1 || s === 0 ? ['#10B981','Online']
    : s === -1         ? ['#8B9CB5','Wait Mode']
    :                    ['#EF4444','Fault'];
  const badge = $('statusBadge');
  badge.innerHTML =
    `<span class="pulse-dot w-1.5 h-1.5 rounded-full" style="background:${color}"></span>` +
    `<span style="color:${color}">${label}</span>`;
  badge.style.cssText += `;border-color:${color}55;background:${color}1a`;
  $('lastRefreshed').textContent = `Refreshed ${fmtTime(new Date())}`;
}

function renderLiveOutput(monitor) {
  const pac   = Number(monitor?.kpi?.pac  ?? 0);
  const capKw = Number(monitor?.info?.capacity ?? 0);
  animateNumber(lastValues.liveW, pac, 700, v => {
    $('liveWatts').textContent = `${Math.round(v).toLocaleString()} W`;
    $('liveWatts').style.color = pac > 0 ? '#F59E0B' : '#8B9CB5';
  });
  lastValues.liveW = pac;
  $('liveCaption').textContent = pac > 0
    ? 'Currently generating'
    : (monitor?.inverter?.[0]?.d?.work_mode || 'Waiting for sunrise');

  const pct = capKw > 0 ? Math.min(100, (pac/(capKw*1000))*100) : 0;
  animateNumber(lastValues.capacity, pct, 900, v => {
    $('capacityBar').style.width = `${v.toFixed(1)}%`;
    $('capacityPct').textContent = `${Math.round(v)}%`;
  });
  lastValues.capacity = pct;
}

function renderKpis(monitor, stale) {
  const kpi  = monitor.kpi || {};
  const today = stale ? 0 : Number(kpi.power || 0);
  const month = Number(kpi.month_generation || 0);
  const totalKwh = Number(kpi.total_power   || 0);

  animateNumber(lastValues.today, today, 700, v =>
    $('kpiToday').textContent = fmt(v, today >= 100 ? 0 : 1));
  lastValues.today = today;

  animateNumber(lastValues.month, month, 700, v =>
    $('kpiMonth').textContent = fmt(v, month >= 1000 ? 0 : 1));
  lastValues.month = month;

  const showMwh = totalKwh >= 1000;
  const tv = showMwh ? totalKwh/1000 : totalKwh;
  animateNumber(lastValues.total, tv, 700, v =>
    $('kpiTotal').textContent = fmt(v, tv >= 100 ? 0 : 1));
  lastValues.total = tv;
  $('kpiTotalUnit').textContent = showMwh ? 'MWh' : 'kWh';
}

function renderEnvironmental(monitor) {
  const e = monitor.hjgx || {};
  $('co2').textContent   = fmt(Number(e.co2  || 0), 2);
  $('trees').textContent = fmt(Number(e.tree || 0), 0);
  $('coal').textContent  = fmt(Number(e.coal || 0), 0);
}

// ─── Power curve ──────────────────────────────────────────────────────────────

let pacChart = null;

function buildChart() {
  pacChart = new Chart($('pacChart'), {
    type: 'line',
    data: { labels:[], datasets:[{
      data: [],
      borderColor: '#F59E0B',
      backgroundColor: c => {
        const {ctx, chartArea} = c.chart;
        if (!chartArea) return 'rgba(245,158,11,0.18)';
        const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        g.addColorStop(0, 'rgba(245,158,11,0.35)');
        g.addColorStop(1, 'rgba(245,158,11,0.00)');
        return g;
      },
      borderWidth:2, fill:true, tension:0.35,
      pointRadius:0, pointHoverRadius:4,
      pointHoverBackgroundColor:'#F59E0B',
    }]},
    options: {
      responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false },
      plugins:{
        legend:{ display:false },
        tooltip:{
          backgroundColor:'#1A2235', borderColor:'#1E2D45', borderWidth:1,
          titleColor:'#FFFFFF', bodyColor:'#F59E0B', padding:10, displayColors:false,
          callbacks:{
            title: items => items[0]?.label || '',
            label: item  => `${Math.round(item.parsed.y).toLocaleString()} W`,
          },
        },
      },
      scales:{
        x:{ grid:{display:false}, ticks:{color:'#8B9CB5',font:{size:10},maxRotation:0,autoSkipPadding:16} },
        y:{ beginAtZero:true, grid:{color:'rgba(30,45,69,0.6)'},
            ticks:{color:'#8B9CB5',font:{size:10},
                   callback: v => v>=1000 ? `${(v/1000).toFixed(1)}k` : v} },
      },
    },
  });
}

function calcKwh(pts) {
  let wh = 0;
  for (let i=0; i<pts.length-1; i++) {
    wh += pts[i].pac * (pts[i+1].t - pts[i].t) / 3_600_000;
  }
  return wh / 1000;
}

function renderPowerCurve({ date, samples }) {
  if (!pacChart) buildChart();
  const pts = (samples||[])
    .map(s => ({ t:parseGoodweTime(s.date), pac:Number(s.pac||0) }))
    .filter(p => p.t);

  pacChart.data.labels = pts.map(p => fmtTime(p.t));
  pacChart.data.datasets[0].data = pts.map(p => p.pac);
  pacChart.update('none');

  const now = new Date();
  const d   = parseGoodweTime((date||'') + ' 00:00:00');
  $('pacSubtitle').textContent = (d && isSameDay(d, now)) ? 'Today' : date || '';

  if (!pts.length) {
    $('peakBadge').classList.add('hidden');
    $('totalBadge').classList.add('hidden');
    return;
  }
  const peak  = pts.reduce((m,p) => p.pac>m ? p.pac : m, 0);
  const total = calcKwh(pts.map(p => ({t:p.t.getTime(), pac:p.pac})));
  $('peakBadge').textContent = `Peak ${Math.round(peak).toLocaleString()} W`;
  $('peakBadge').classList.remove('hidden');
  if (total > 0) {
    $('totalBadge').textContent = `Total ${total.toFixed(2)} kWh`;
    $('totalBadge').classList.remove('hidden');
  } else {
    $('totalBadge').classList.add('hidden');
  }
}

function renderAll(monitor, pac) {
  const stale = isSolarStale(monitor);
  renderHeader(monitor);
  renderLiveOutput(stale ? {...monitor, kpi:{...monitor.kpi, pac:0}} : monitor);
  renderKpis(monitor, stale);
  renderEnvironmental(monitor);
  if (pac) renderPowerCurve(pac);
}

// ─── Polling ──────────────────────────────────────────────────────────────────

let pollTimer = null;

async function refresh() {
  $('errorBox').classList.add('hidden');
  try {
    const [monitor, pac] = await Promise.all([
      fetchJson('/api/monitor'),
      fetchJson('/api/pac'),
    ]);
    renderAll(monitor, pac);
  } catch(err) {
    if (err.status === 401) {
      clearCreds();
      showLogin();
    } else {
      $('errorBox').textContent = `⚠ ${err.message}`;
      $('errorBox').classList.remove('hidden');
    }
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else if (hasCreds()) { refresh(); startPolling(); }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

initLoginForm();
initSignOut();

if (hasCreds()) {
  // Returning user — jump straight to dashboard, load data
  showDashboard();
  refresh().then(startPolling);
} else {
  // First visit or signed out — show login
  showLogin();
}
