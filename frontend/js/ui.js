// Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
// SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

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

  /** Interactive chart (TradingView Lightweight Charts) from our own
   *  {date, close} history, with a toolbar: time-range buttons, a volatility-
   *  band toggle (20d MA ± 2σ) and benchmark overlays (BIST 100 / NASDAQ).
   *  All data is ours; benchmarks: [{key,label,symbol,color}] lazy-fetched. */
  interactiveChart(el, history, { precision = 2, benchmarks = [] } = {}) {
    if (typeof LightweightCharts === 'undefined' || !history || !history.length) return null;
    const t = (k) => (typeof I18N !== 'undefined' ? I18N.t(k) : k);

    // Toolbar (range buttons + toggles) + chart canvas
    el.innerHTML = '';
    const RANGES = [['1m', 30], ['3m', 90], ['6m', 180], ['1y', 365], ['all', 0]];
    const bar = document.createElement('div');
    bar.className = 'ia-toolbar';
    bar.innerHTML =
      '<span class="ia-ranges">' +
        RANGES.map(([k, d]) => `<button class="btn ia-range${d === 365 ? ' active' : ''}" data-days="${d}">${t('range.' + k)}</button>`).join('') +
      '</span><span class="ia-toggles">' +
        `<button class="btn ia-tg" data-tg="bands">${t('chart.bands')}</button>` +
        benchmarks.map((b) => `<button class="btn ia-tg" data-tg="bm" data-key="${b.key}" style="--tgc:${b.color}">${UI.esc(b.label)}</button>`).join('') +
      '</span>';
    const canvas = document.createElement('div');
    canvas.className = 'ia-canvas';
    el.appendChild(bar);
    el.appendChild(canvas);

    const chart = LightweightCharts.createChart(canvas, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'rgba(0,0,0,0)' },
        textColor: '#7e8fa0', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
      grid: { vertLines: { color: '#141f2b' }, horzLines: { color: '#141f2b' } },
      rightPriceScale: { borderColor: '#1c2936' },
      timeScale: { borderColor: '#1c2936' },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: '#ffb000', width: 1, labelBackgroundColor: '#ffb000' },
        horzLine: { color: '#ffb000', width: 1, labelBackgroundColor: '#ffb000' },
      },
    });
    const area = chart.addAreaSeries({
      lineWidth: 2, priceLineVisible: false,
      priceFormat: { type: 'price', precision, minMove: 1 / Math.pow(10, precision) },
    });

    const slice = (h, d) => {
      if (!d) return h;
      const cut = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
      return h.filter((x) => x.date >= cut);
    };

    let days = 365, bandsOn = false, bands = null;
    const bm = {};  // key -> { on, data, series }

    function drawBands() {
      if (bandsOn) {
        const s = slice(history, days), win = 20, k = 2, up = [], mid = [], lo = [];
        for (let i = win - 1; i < s.length; i++) {
          let sum = 0;
          for (let j = i - win + 1; j <= i; j++) sum += s[j].close;
          const m = sum / win;
          let v = 0;
          for (let j = i - win + 1; j <= i; j++) v += (s[j].close - m) ** 2;
          const sd = Math.sqrt(v / win);
          mid.push({ time: s[i].date, value: m });
          up.push({ time: s[i].date, value: m + k * sd });
          lo.push({ time: s[i].date, value: m - k * sd });
        }
        if (!bands) {
          const o = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
          bands = {
            up: chart.addLineSeries({ ...o, color: 'rgba(255,176,0,0.45)' }),
            mid: chart.addLineSeries({ ...o, color: 'rgba(255,176,0,0.85)', lineStyle: 2 }),
            lo: chart.addLineSeries({ ...o, color: 'rgba(255,176,0,0.45)' }),
          };
        }
        bands.up.setData(up); bands.mid.setData(mid); bands.lo.setData(lo);
      } else if (bands) {
        chart.removeSeries(bands.up); chart.removeSeries(bands.mid); chart.removeSeries(bands.lo);
        bands = null;
      }
    }

    async function drawBenchmark(b) {
      const st = bm[b.key];
      if (!st || !st.on) return;
      if (!st.data) {
        try { st.data = (await API.history(b.symbol, '1y')).history || []; }
        catch (e) { st.data = []; }
      }
      if (!st.series) {
        st.series = chart.addLineSeries({ color: b.color, lineWidth: 1, priceScaleId: 'ovl_' + b.key,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        chart.priceScale('ovl_' + b.key).applyOptions({ visible: false, scaleMargins: { top: 0.1, bottom: 0.1 } });
      }
      st.series.setData(slice(st.data, days).map((x) => ({ time: x.date, value: x.close })));
    }

    function refreshMain() {
      const s = slice(history, days);
      const f = s.length ? s[0].close : 0, l = s.length ? s[s.length - 1].close : 0;
      const c = l >= f ? UI.COLORS.green : UI.COLORS.red;
      area.applyOptions({ lineColor: c, topColor: c + '44', bottomColor: c + '05' });
      area.setData(s.map((x) => ({ time: x.date, value: x.close })));
      drawBands();
      benchmarks.forEach(drawBenchmark);
      chart.timeScale().fitContent();
    }

    bar.addEventListener('click', (e) => {
      const rb = e.target.closest('button[data-days]');
      if (rb) {
        days = Number(rb.dataset.days);
        bar.querySelectorAll('.ia-range').forEach((x) => x.classList.remove('active'));
        rb.classList.add('active');
        refreshMain();
        return;
      }
      const tg = e.target.closest('button[data-tg]');
      if (!tg) return;
      if (tg.dataset.tg === 'bands') {
        bandsOn = !bandsOn;
        tg.classList.toggle('active', bandsOn);
        drawBands();
      } else {
        const b = benchmarks.find((x) => x.key === tg.dataset.key);
        const st = bm[b.key] || (bm[b.key] = { on: false, data: null, series: null });
        st.on = !st.on;
        tg.classList.toggle('active', st.on);
        if (st.on) drawBenchmark(b);
        else if (st.series) { chart.removeSeries(st.series); st.series = null; }
      }
    });

    refreshMain();
    return chart;
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
