// ─── Beacon — client logic ────────────────────────────────────────────────────
// Fetches /api/monitor and /api/pac, renders the dashboard, polls every 15s
// while the tab is visible.

const POLL_INTERVAL_MS = 15_000;

// Last rendered values for smooth animated transitions
const lastValues = { liveW: 0, today: 0, month: 0, total: 0, capacity: 0 };

let pacChart = null;
let pollTimer = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth() &&
         a.getDate()     === b.getDate();
}

/** Parses GoodWe's "yyyy-MM-dd HH:mm:ss" or "MM/dd/yyyy HH:mm:ss" timestamps. */
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

/** True when the inverter's last report is from a previous calendar day. */
function isSolarStale(monitor) {
  const lastStr =
    monitor?.inverter?.[0]?.d?.last_refresh_time ?? '';
  const last = parseGoodweTime(lastStr);
  if (!last) return false;
  const now = new Date();
  return new Date(last.getFullYear(), last.getMonth(), last.getDate())
       < new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Animates a number from `from` → `to` over `ms`, calling onFrame(value). */
function animateNumber(from, to, ms, onFrame) {
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
  function tick(now) {
    const t = Math.min(1, (now - start) / ms);
    const v = from + (to - from) * ease(t);
    onFrame(v);
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
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Network ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Renderers ────────────────────────────────────────────────────────────────

function renderHeader(monitor) {
  const info = monitor.info || {};
  $('stationName').textContent = info.stationname || 'Solar';
  $('stationAddress').textContent = info.address || '';

  // Status badge
  const badge = $('statusBadge');
  const status = info.status;
  let color, label;
  if (status === 1 || status === 0) { color = '#10B981'; label = 'Online'; }
  else if (status === -1)            { color = '#8B9CB5'; label = 'Wait Mode'; }
  else                               { color = '#EF4444'; label = 'Fault'; }
  badge.innerHTML =
    `<span class="pulse-dot w-1.5 h-1.5 rounded-full" style="background:${color}"></span>` +
    `<span style="color:${color}">${label}</span>`;
  badge.style.borderColor = color + '55';
  badge.style.background = color + '1a';

  $('lastRefreshed').textContent = `Refreshed ${formatTime(new Date())}`;
}

function renderLiveOutput(monitor) {
  const pac = Number(monitor?.kpi?.pac ?? 0);
  const capacityKw = Number(monitor?.info?.capacity ?? 0);
  const generating = pac > 0;

  // Live watts (animated)
  animateNumber(lastValues.liveW, pac, 700, (v) => {
    $('liveWatts').textContent = `${Math.round(v).toLocaleString()} W`;
  });
  lastValues.liveW = pac;

  // Caption + colour
  const watts = $('liveWatts');
  if (generating) {
    watts.classList.remove('text-textSec');
    watts.classList.add('text-accent');
    $('liveCaption').textContent = 'Currently generating';
  } else {
    watts.classList.remove('text-accent');
    watts.classList.add('text-textSec');
    const wm = monitor?.inverter?.[0]?.d?.work_mode || '';
    $('liveCaption').textContent = wm || 'Waiting for sunrise';
  }

  // Capacity bar
  const capW = capacityKw * 1000;
  const pct = capW > 0 ? Math.min(100, (pac / capW) * 100) : 0;
  animateNumber(lastValues.capacity, pct, 900, (v) => {
    $('capacityBar').style.width = `${v.toFixed(1)}%`;
    $('capacityPct').textContent = `${Math.round(v)}%`;
  });
  lastValues.capacity = pct;
}

function renderKpis(monitor, stale) {
  const kpi = monitor.kpi || {};
  const today = stale ? 0 : Number(kpi.power || 0);
  const month = Number(kpi.month_generation || 0);
  const totalKwh = Number(kpi.total_power || 0);

  animateNumber(lastValues.today, today, 700, (v) => {
    $('kpiToday').textContent = fmt(v, today >= 100 ? 0 : 1);
  });
  lastValues.today = today;

  animateNumber(lastValues.month, month, 700, (v) => {
    $('kpiMonth').textContent = fmt(v, month >= 1000 ? 0 : 1);
  });
  lastValues.month = month;

  // Total — auto-switch to MWh when ≥ 1000 kWh
  const showMwh = totalKwh >= 1000;
  const totalVal = showMwh ? totalKwh / 1000 : totalKwh;
  animateNumber(lastValues.total, totalVal, 700, (v) => {
    $('kpiTotal').textContent = fmt(v, totalVal >= 100 ? 0 : 1);
  });
  lastValues.total = totalVal;
  $('kpiTotalUnit').textContent = showMwh ? 'MWh' : 'kWh';
}

function renderEnvironmental(monitor) {
  const env = monitor.hjgx || {};
  $('co2').textContent   = fmt(env.co2 || 0, 2);
  $('trees').textContent = fmt(env.tree || 0, 0);
  $('coal').textContent  = fmt(env.coal || 0, 0);
}

// ─── Power curve ──────────────────────────────────────────────────────────────

function buildChart() {
  const ctx = $('pacChart');
  pacChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: '#F59E0B',
        backgroundColor: (c) => {
          const { ctx, chartArea } = c.chart;
          if (!chartArea) return 'rgba(245,158,11,0.18)';
          const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0,    'rgba(245,158,11,0.35)');
          g.addColorStop(1,    'rgba(245,158,11,0.00)');
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
            title: (items) => items[0]?.label || '',
            label: (item) => `${Math.round(item.parsed.y).toLocaleString()} W`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#8B9CB5',
            font: { size: 10 },
            maxRotation: 0,
            autoSkipPadding: 16,
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(30,45,69,0.6)' },
          ticks: {
            color: '#8B9CB5',
            font: { size: 10 },
            callback: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v),
          },
        },
      },
    },
  });
}

/** Trapezoid integration of PAC samples → kWh. */
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
  const points = (samples || []).map((s) => {
    // Sample shape from SEMS: { date: "MM/DD/YYYY HH:mm:ss", pac: <W> }
    const t = parseGoodweTime(s.date);
    return { t, pac: Number(s.pac || 0), label: t ? formatTime(t) : '' };
  }).filter((p) => p.t);

  pacChart.data.labels = points.map((p) => p.label);
  pacChart.data.datasets[0].data = points.map((p) => p.pac);
  pacChart.update('none');

  // Subtitle + badges
  const today = new Date();
  const sub = date && isSameDay(parseGoodweTime(date + ' 00:00:00') || today, today)
    ? 'Today'
    : date || '';
  $('pacSubtitle').textContent = sub;

  const peakBadge  = $('peakBadge');
  const totalBadge = $('totalBadge');
  if (points.length === 0) {
    peakBadge.classList.add('hidden');
    totalBadge.classList.add('hidden');
    return;
  }
  const peak = points.reduce((m, p) => p.pac > m ? p.pac : m, 0);
  peakBadge.textContent = `Peak ${Math.round(peak).toLocaleString()} W`;
  peakBadge.classList.remove('hidden');

  const total = totalKwh(points.map((p) => ({ t: p.t.getTime(), pac: p.pac })));
  if (total > 0) {
    totalBadge.textContent = `Total ${total.toFixed(2)} kWh`;
    totalBadge.classList.remove('hidden');
  } else {
    totalBadge.classList.add('hidden');
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
    showError(err.message);
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

// Pause polling when the tab is hidden; resume + refresh on return
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    refresh();
    startPolling();
  }
});

// Initial boot
refresh().then(startPolling);
