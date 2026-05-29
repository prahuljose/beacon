// ─── Beacon — client logic ────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 15_000;
const DEFAULT_STATION_ID = 'e3c2c54c-c872-4fdb-8147-99381e685cff';
const STORAGE_KEYS = {
  email:     'beacon_email',
  password:  'beacon_password',
  stationId: 'beacon_station_id',
};

const lastValues = { liveW: 0, today: 0, month: 0, total: 0, capacity: 0 };
let pacChart  = null;
let pollTimer = null;

// ─── Credentials (localStorage) ──────────────────────────────────────────────

function getCreds() {
  return {
    email:     localStorage.getItem(STORAGE_KEYS.email)     || '',
    password:  localStorage.getItem(STORAGE_KEYS.password)  || '',
    stationId: localStorage.getItem(STORAGE_KEYS.stationId) || DEFAULT_STATION_ID,
  };
}

function saveCreds({ email, password, stationId }) {
  localStorage.setItem(STORAGE_KEYS.email,     email);
  localStorage.setItem(STORAGE_KEYS.password,  password);
  localStorage.setItem(STORAGE_KEYS.stationId, stationId);
}

function hasCredentials() {
  const { email, password } = getCreds();
  return email.trim().length > 0 && password.trim().length > 0;
}

// ─── Settings panel ───────────────────────────────────────────────────────────

function buildSettingsPanel() {
  const panel = document.createElement('div');
  panel.id = 'settingsPanel';
  panel.className = 'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4';
  panel.style.background = 'rgba(10,14,26,0.85)';
  panel.style.backdropFilter = 'blur(6px)';

  panel.innerHTML = `
    <div class="w-full max-w-sm rounded-3xl border border-divider p-7"
         style="background:#141927;">
      <!-- Handle (mobile) -->
      <div class="flex justify-center mb-5 sm:hidden">
        <div class="w-10 h-1 rounded-full bg-divider"></div>
      </div>

      <!-- Header -->
      <div class="flex items-center gap-3 mb-6">
        <div class="w-9 h-9 rounded-xl flex items-center justify-center"
             style="background:rgba(245,158,11,0.15);">
          <svg viewBox="0 0 24 24" class="w-5 h-5 text-accent" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14
                     M1 12h2M21 12h2M12 1v2M12 21v2"/>
          </svg>
        </div>
        <div>
          <h2 class="font-semibold text-base">SEMS Account</h2>
          <p class="text-xs text-textSec">Enter your GoodWe / SEMS credentials</p>
        </div>
      </div>

      <!-- Form -->
      <form id="settingsForm" class="space-y-4" autocomplete="on">
        <div>
          <label class="block text-xs font-medium text-textPrim mb-1.5">Email</label>
          <input id="sEmail" type="email" autocomplete="email"
                 placeholder="you@example.com"
                 class="w-full px-4 py-3 rounded-xl text-sm bg-cardAlt border border-divider
                        text-textPrim placeholder-textSec outline-none
                        focus:border-accent transition-colors duration-150">
        </div>
        <div>
          <label class="block text-xs font-medium text-textPrim mb-1.5">Password</label>
          <div class="relative">
            <input id="sPassword" type="password" autocomplete="current-password"
                   placeholder="••••••••"
                   class="w-full px-4 py-3 rounded-xl text-sm bg-cardAlt border border-divider
                          text-textPrim placeholder-textSec outline-none
                          focus:border-accent transition-colors duration-150 pr-11">
            <button type="button" id="togglePwd"
                    class="absolute right-3 top-1/2 -translate-y-1/2 text-textSec hover:text-textPrim">
              <svg id="eyeIcon" viewBox="0 0 24 24" class="w-4 h-4" fill="none"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-textPrim mb-1.5">Station ID</label>
          <input id="sStationId" type="text" autocomplete="off"
                 placeholder="${DEFAULT_STATION_ID}"
                 class="w-full px-4 py-3 rounded-xl text-xs font-mono bg-cardAlt border
                        border-divider text-textPrim placeholder-textSec outline-none
                        focus:border-accent transition-colors duration-150">
          <p class="text-[10px] text-textSec mt-1.5">
            Find in SEMS portal URL, or leave as-is to use the default station.
          </p>
        </div>

        <div id="settingsError"
             class="hidden text-xs text-red px-3 py-2.5 rounded-xl"
             style="background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.25);">
        </div>

        <button type="submit" id="saveBtn"
                class="w-full py-3.5 rounded-2xl font-semibold text-sm text-black
                       bg-accent hover:bg-accentDk active:scale-[0.98]
                       transition-all duration-150 flex items-center justify-center gap-2">
          <span id="saveBtnText">Connect</span>
          <svg id="saveBtnSpinner" class="hidden w-4 h-4 animate-spin" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83
                     M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
        </button>
      </form>
    </div>
  `;

  document.body.appendChild(panel);

  // Pre-fill existing creds
  const { email, password, stationId } = getCreds();
  document.getElementById('sEmail').value     = email;
  document.getElementById('sPassword').value  = password;
  document.getElementById('sStationId').value = stationId !== DEFAULT_STATION_ID ? stationId : '';

  // Toggle password visibility
  document.getElementById('togglePwd').addEventListener('click', () => {
    const inp  = document.getElementById('sPassword');
    const icon = document.getElementById('eyeIcon');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    icon.innerHTML = show
      ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
         <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
         <line x1="1" y1="1" x2="23" y2="23"/>`
      : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
         <circle cx="12" cy="12" r="3"/>`;
  });

  // Form submit
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('settingsError');
    const btn    = document.getElementById('saveBtn');
    errBox.classList.add('hidden');
    btn.disabled = true;
    document.getElementById('saveBtnText').textContent = 'Connecting…';
    document.getElementById('saveBtnSpinner').classList.remove('hidden');

    const email     = document.getElementById('sEmail').value.trim();
    const password  = document.getElementById('sPassword').value;
    const stationId = document.getElementById('sStationId').value.trim() || DEFAULT_STATION_ID;

    try {
      saveCreds({ email, password, stationId });
      // Quick smoke-test: try fetching monitor with new creds
      await fetchJson('/api/monitor');
      closeSettings();
      await refresh();
      startPolling();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
      btn.disabled = false;
      document.getElementById('saveBtnText').textContent = 'Connect';
      document.getElementById('saveBtnSpinner').classList.add('hidden');
    }
  });
}

function openSettings() {
  let panel = document.getElementById('settingsPanel');
  if (!panel) buildSettingsPanel();
  document.getElementById('settingsPanel').classList.remove('hidden');
}

function closeSettings() {
  const panel = document.getElementById('settingsPanel');
  if (panel) panel.classList.add('hidden');
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

function parseGoodweTime(s) {
  if (!s || typeof s !== 'string') return null;
  const parts = s.trim().split(' ');
  const datePart = parts[0];
  const timePart = parts[1] || '00:00:00';
  const [hh = 0, mm = 0, ss = 0] = timePart.split(':').map(Number);
  try {
    if (datePart.includes('-')) {
      const [y, m, d] = datePart.split('-').map(Number);
      return new Date(y, m - 1, d, hh, mm, ss);
    }
    if (datePart.includes('/')) {
      const [m, d, y] = datePart.split('/').map(Number);
      return new Date(y, m - 1, d, hh, mm, ss);
    }
  } catch (_) {}
  return null;
}

function isSolarStale(monitor) {
  const lastStr = monitor?.inverter?.[0]?.d?.last_refresh_time ?? '';
  const last = parseGoodweTime(lastStr);
  if (!last) return false;
  const now = new Date();
  return new Date(last.getFullYear(), last.getMonth(), last.getDate())
       < new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function animateNumber(from, to, ms, onFrame) {
  const start = performance.now();
  const ease  = t => 1 - Math.pow(1 - t, 3);
  function tick(now) {
    const t = Math.min(1, (now - start) / ms);
    onFrame(from + (to - from) * ease(t));
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function fmt(n, d = 1) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function formatTime(d) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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

// ─── Renderers ────────────────────────────────────────────────────────────────

function renderHeader(monitor) {
  const info = monitor.info || {};
  $('stationName').textContent    = info.stationname || 'Solar Dashboard';
  $('stationAddress').textContent = info.address || '';

  const badge  = $('statusBadge');
  const status = info.status;
  let color, label;
  if (status === 1 || status === 0)  { color = '#10B981'; label = 'Online'; }
  else if (status === -1)            { color = '#8B9CB5'; label = 'Wait Mode'; }
  else                               { color = '#EF4444'; label = 'Fault'; }
  badge.innerHTML =
    `<span class="pulse-dot w-1.5 h-1.5 rounded-full" style="background:${color}"></span>` +
    `<span style="color:${color}">${label}</span>`;
  badge.style.borderColor = color + '55';
  badge.style.background  = color + '1a';
  $('lastRefreshed').textContent = `Refreshed ${formatTime(new Date())}`;
}

function renderLiveOutput(monitor) {
  const pac = Number(monitor?.kpi?.pac ?? 0);
  const capKw = Number(monitor?.info?.capacity ?? 0);

  animateNumber(lastValues.liveW, pac, 700, v => {
    $('liveWatts').textContent = `${Math.round(v).toLocaleString()} W`;
  });
  lastValues.liveW = pac;

  const watts = $('liveWatts');
  if (pac > 0) {
    watts.style.color = '#F59E0B';
    $('liveCaption').textContent = 'Currently generating';
  } else {
    watts.style.color = '#8B9CB5';
    const wm = monitor?.inverter?.[0]?.d?.work_mode || '';
    $('liveCaption').textContent = wm || 'Waiting for sunrise';
  }

  const pct = capKw > 0 ? Math.min(100, (pac / (capKw * 1000)) * 100) : 0;
  animateNumber(lastValues.capacity, pct, 900, v => {
    $('capacityBar').style.width = `${v.toFixed(1)}%`;
    $('capacityPct').textContent = `${Math.round(v)}%`;
  });
  lastValues.capacity = pct;
}

function renderKpis(monitor, stale) {
  const kpi   = monitor.kpi || {};
  const today = stale ? 0 : Number(kpi.power || 0);
  const month = Number(kpi.month_generation || 0);
  const totalKwh = Number(kpi.total_power || 0);

  animateNumber(lastValues.today, today, 700, v => {
    $('kpiToday').textContent = fmt(v, today >= 100 ? 0 : 1);
  });
  lastValues.today = today;

  animateNumber(lastValues.month, month, 700, v => {
    $('kpiMonth').textContent = fmt(v, month >= 1000 ? 0 : 1);
  });
  lastValues.month = month;

  const showMwh = totalKwh >= 1000;
  const totalVal = showMwh ? totalKwh / 1000 : totalKwh;
  animateNumber(lastValues.total, totalVal, 700, v => {
    $('kpiTotal').textContent = fmt(v, totalVal >= 100 ? 0 : 1);
  });
  lastValues.total = totalVal;
  $('kpiTotalUnit').textContent = showMwh ? 'MWh' : 'kWh';
}

function renderEnvironmental(monitor) {
  const env = monitor.hjgx || {};
  $('co2').textContent   = fmt(Number(env.co2   || 0), 2);
  $('trees').textContent = fmt(Number(env.tree  || 0), 0);
  $('coal').textContent  = fmt(Number(env.coal  || 0), 0);
}

// ─── Power curve ──────────────────────────────────────────────────────────────

function buildChart() {
  pacChart = new Chart($('pacChart'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: '#F59E0B',
        backgroundColor: c => {
          const { ctx, chartArea } = c.chart;
          if (!chartArea) return 'rgba(245,158,11,0.18)';
          const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0, 'rgba(245,158,11,0.35)');
          g.addColorStop(1, 'rgba(245,158,11,0.00)');
          return g;
        },
        borderWidth: 2,
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#F59E0B',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1A2235',
          borderColor: '#1E2D45',
          borderWidth: 1,
          titleColor: '#FFFFFF',
          bodyColor: '#F59E0B',
          padding: 10,
          displayColors: false,
          callbacks: {
            title: items => items[0]?.label || '',
            label: item => `${Math.round(item.parsed.y).toLocaleString()} W`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#8B9CB5', font: { size: 10 },
            maxRotation: 0, autoSkipPadding: 16,
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(30,45,69,0.6)' },
          ticks: {
            color: '#8B9CB5', font: { size: 10 },
            callback: v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v,
          },
        },
      },
    },
  });
}

function totalKwh(samples) {
  if (samples.length < 2) return 0;
  let wh = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const dtH = (samples[i + 1].t - samples[i].t) / 3_600_000;
    wh += samples[i].pac * dtH;
  }
  return wh / 1000;
}

function renderPowerCurve({ date, samples }) {
  if (!pacChart) buildChart();
  const points = (samples || [])
    .map(s => {
      const t = parseGoodweTime(s.date);
      return { t, pac: Number(s.pac || 0), label: t ? formatTime(t) : '' };
    })
    .filter(p => p.t);

  pacChart.data.labels = points.map(p => p.label);
  pacChart.data.datasets[0].data = points.map(p => p.pac);
  pacChart.update('none');

  const today  = new Date();
  const parsed = parseGoodweTime(date + ' 00:00:00');
  $('pacSubtitle').textContent =
    (parsed && isSameDay(parsed, today)) ? 'Today' : date || '';

  const peak = points.reduce((m, p) => p.pac > m ? p.pac : m, 0);
  if (points.length > 0) {
    $('peakBadge').textContent = `Peak ${Math.round(peak).toLocaleString()} W`;
    $('peakBadge').classList.remove('hidden');
    const total = totalKwh(points.map(p => ({ t: p.t.getTime(), pac: p.pac })));
    if (total > 0) {
      $('totalBadge').textContent = `Total ${total.toFixed(2)} kWh`;
      $('totalBadge').classList.remove('hidden');
    } else {
      $('totalBadge').classList.add('hidden');
    }
  } else {
    $('peakBadge').classList.add('hidden');
    $('totalBadge').classList.add('hidden');
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────────

async function refresh() {
  hideError();
  try {
    const [monitor, pac] = await Promise.all([
      fetchJson('/api/monitor'),
      fetchJson('/api/pac'),
    ]);
    const stale = isSolarStale(monitor);
    renderHeader(monitor);
    renderLiveOutput(stale ? { ...monitor, kpi: { ...monitor.kpi, pac: 0 } } : monitor);
    renderKpis(monitor, stale);
    renderEnvironmental(monitor);
    renderPowerCurve(pac);
  } catch (err) {
    if (err.status === 401) {
      // Bad or missing credentials — show settings panel
      stopPolling();
      openSettings();
    } else {
      showError(err.message);
    }
  }
}

function showError(msg) {
  const box = $('errorBox');
  box.textContent = `⚠ ${msg}`;
  box.classList.remove('hidden');
}

function hideError() {
  $('errorBox').classList.add('hidden');
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else { refresh(); startPolling(); }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

function boot() {
  // Wire the settings gear icon
  document.getElementById('settingsGear')?.addEventListener('click', openSettings);

  if (!hasCredentials()) {
    // First visit — show settings immediately
    buildSettingsPanel();
  } else {
    refresh().then(startPolling);
  }
}

boot();
