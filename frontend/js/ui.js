// Shared UI helpers: number formatting, clock, chart theming, common widgets.
const UI = {
  fmtNum(v, dec = 2) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  },
  fmtPct(v, dec = 2, signed = false) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const s = signed && v > 0 ? '+' : '';
    return s + (v * 100).toFixed(dec) + '%';
  },
  fmtPctRaw(v, dec = 2, signed = true) { // value already in percent units
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const s = signed && v > 0 ? '+' : '';
    return s + Number(v).toFixed(dec) + '%';
  },
  fmtBig(v, currency = '') {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const abs = Math.abs(v);
    let out;
    if (abs >= 1e12) out = (v / 1e12).toFixed(2) + 'T';
    else if (abs >= 1e9) out = (v / 1e9).toFixed(2) + 'B';
    else if (abs >= 1e6) out = (v / 1e6).toFixed(2) + 'M';
    else if (abs >= 1e3) out = (v / 1e3).toFixed(1) + 'K';
    else out = String(Math.round(v));
    return out + (currency ? ' ' + currency : '');
  },
  chgClass(v) { return v > 0 ? 'up' : v < 0 ? 'down' : 'neu'; },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  qs(name) { return new URLSearchParams(location.search).get(name); },
  timeAgo(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  },
  debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },

  startClock() {
    const el = document.getElementById('clock');
    if (!el) return;
    const tick = () => {
      const now = new Date();
      const ist = now.toLocaleTimeString('en-GB', { timeZone: 'Europe/Istanbul', hour12: false });
      const utc = now.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false });
      el.innerHTML = `IST <b>${ist}</b> &nbsp;UTC ${utc}`;
    };
    tick();
    setInterval(tick, 1000);
  },

  initTopSearch() {
    const input = document.getElementById('top-search');
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        location.href = `index.html?q=${encodeURIComponent(input.value.trim())}`;
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== input && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
        e.preventDefault();
        input.focus();
      }
    });
  },

  // ---- Chart.js theming (dark terminal) --------------------------------
  COLORS: {
    amber: '#ffb000', cyan: '#38bdf8', violet: '#a78bfa', pink: '#f472b6',
    green: '#2fd07e', red: '#ff5252', muted: '#7e8fa0',
    categorical: ['#ffb000', '#38bdf8', '#a78bfa', '#f472b6', '#2fd07e', '#fb923c', '#60a5fa', '#94a3b8'],
  },

  themeCharts() {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.font.family = getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = '#7e8fa0';
    Chart.defaults.borderColor = '#1c2936';
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.tooltip.backgroundColor = '#101a24';
    Chart.defaults.plugins.tooltip.borderColor = '#2b3d4f';
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.titleColor = '#ffb000';
    Chart.defaults.plugins.tooltip.bodyColor = '#d7e0e7';
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.displayColors = false;
    Chart.defaults.animation.duration = 350;
  },

  /** Single-series price line with subtle area fill and crosshair tooltip. */
  priceChart(canvas, dates, values, { color = '#ffb000', currency = '' } = {}) {
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.parentElement.clientHeight || 320);
    grad.addColorStop(0, color + '33');
    grad.addColorStop(1, color + '00');
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: dates,
        datasets: [{
          data: values, borderColor: color, backgroundColor: grad,
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
          pointHoverBackgroundColor: color, fill: true, tension: 0.1,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => `${UI.fmtNum(c.parsed.y, c.parsed.y < 10 ? 4 : 2)} ${currency}`.trim(),
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              maxTicksLimit: 7, maxRotation: 0,
              callback(v) {
                const d = new Date(this.getLabelForValue(v));
                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
              },
            },
          },
          y: {
            position: 'right',
            grid: { color: '#141f2b' },
            ticks: { callback: (v) => UI.fmtNum(v, v < 10 ? 3 : v < 1000 ? 2 : 0) },
          },
        },
      },
    });
  },

  sentimentBadge(sent) {
    const label = sent && sent.label ? sent.label : 'neutral';
    const text = label === 'positive' ? 'POS' : label === 'negative' ? 'NEG' : 'NEU';
    const impact = typeof I18N !== 'undefined' ? I18N.t('news.impact') : 'Estimated impact';
    return `<span class="sent-label">${text}</span><span class="sent-dot ${label}" title="${impact}: ${label}"></span>`;
  },

  newsCard(item) {
    return `<a class="news-item" href="${UI.esc(item.link || '#')}" target="_blank" rel="noopener">
      ${UI.sentimentBadge(item.sentiment)}
      <div class="title">${UI.esc(item.title)}</div>
      <div class="meta">${UI.esc(item.source || '')} · ${UI.timeAgo(item.date)}</div>
    </a>`;
  },
};

document.addEventListener('DOMContentLoaded', () => {
  UI.startClock();
  UI.initTopSearch();
  UI.themeCharts();
});
