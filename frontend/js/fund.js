// TEFAS fund detail page: NAV chart, AUM/investors, allocation doughnut,
// risk metrics, TEFAS period returns, sentiment news.
(function () {
  const code = UI.qs('code');
  if (!code) { location.replace('index.html'); return; }
  document.title = `${code.toUpperCase()} — FINANSLA TERMINAL`;
  const t = I18N.t.bind(I18N);

  let fullHistory = [];
  let priceChart = null;

  const RANGE_LABELS = { 30: '1M', 90: '3M', 180: '6M', 365: '1Y' };

  function renderChart(days) {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const slice = fullHistory.filter((h) => h.date >= cutoff);
    if (priceChart) priceChart.destroy();
    const first = slice[0]?.close, last = slice[slice.length - 1]?.close;
    const color = last >= first ? UI.COLORS.green : UI.COLORS.red;
    priceChart = UI.priceChart(document.getElementById('price-chart'),
      slice.map((h) => h.date), slice.map((h) => h.close), { color, currency: 'TRY' });

    // Show the selected range's return next to the NAV
    if (slice.length > 1) {
      const chg = last - first;
      const pct = (last / first - 1) * 100;
      document.getElementById('range-lbl').textContent = RANGE_LABELS[days] || `${days}D`;
      const rc = document.getElementById('range-chg');
      rc.textContent = `${chg > 0 ? '+' : ''}${UI.fmtNum(chg, last < 10 ? 4 : 2)} (${UI.fmtPctRaw(pct)})`;
      rc.className = `chg mono-num ${UI.chgClass(chg)}`;
    }
  }

  function statRow(k, v, cls = '') {
    return `<div class="row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  }

  async function load() {
    let data;
    try {
      data = await API.fund(code);
    } catch (err) {
      document.getElementById('page-loading').outerHTML =
        `<div class="error-box">${UI.esc(code.toUpperCase())} ${t('err.load')} — ${UI.esc(err.message)}</div>`;
      return;
    }
    const { profile, latest, returns, history, risk, allocation } = data;
    fullHistory = history;

    document.getElementById('page-loading').hidden = true;
    document.getElementById('content').hidden = false;

    // Identity: fund code with the fund's full title underneath
    document.getElementById('code').textContent = profile.code;
    document.getElementById('fullname').textContent = profile.title;
    // SERBEST (hedge) funds are restricted to qualified investors in Turkey -
    // flag them with a red tag so nobody mistakes them for retail products.
    const isSerbest = /SERBEST/i.test(`${profile.category || ''} ${profile.title || ''}`);
    document.getElementById('tags').innerHTML = [
      '<span class="tag">TEFAS</span>',
      profile.category
        ? `<span class="tag${isSerbest ? ' danger' : ''}">${UI.esc(profile.category)}${isSerbest ? ' · ' + t('tag.qualified') : ''}</span>`
        : (isSerbest ? `<span class="tag danger">${t('tag.qualified')}</span>` : ''),
    ].join('');
    document.getElementById('px').textContent = UI.fmtNum(latest.price, latest.price < 10 ? 6 : 4);
    document.getElementById('navdate').textContent = `${t('asof')}: ${latest.date}`;

    // Stats
    const ret1d = history.length > 1
      ? history[history.length - 1].close / history[history.length - 2].close - 1 : null;
    document.getElementById('stats').innerHTML = [
      statRow(t('k.aum'), UI.fmtBig(latest.aum, 'TRY')),
      statRow(t('k.investors'), latest.investors != null ? Number(latest.investors).toLocaleString(I18N.lang === 'tr' ? 'tr-TR' : 'en-US') : '—'),
      statRow(t('k.shares'), UI.fmtBig(latest.shares)),
      statRow(t('k.lastnav'), latest.date),
      statRow(t('k.dailychg'), UI.fmtPct(ret1d, 2, true), UI.chgClass(ret1d)),
      statRow(t('k.category'), UI.esc(profile.category || '—')),
    ].join('');

    // TEFAS period returns
    const R = returns || {};
    const retRow = (label, v) => statRow(label, UI.fmtPctRaw(v, 2), UI.chgClass(v));
    document.getElementById('returns').innerHTML = [
      retRow(t('ret.1m'), R['1m']), retRow(t('ret.3m'), R['3m']), retRow(t('ret.6m'), R['6m']),
      retRow(t('ret.ytd'), R.ytd), retRow(t('ret.1y'), R['1y']),
      R['3y'] != null ? retRow(t('ret.3y'), R['3y']) : '',
      R['5y'] != null ? retRow(t('ret.5y'), R['5y']) : '',
    ].join('') || `<div class="row"><span class="k faint">${t('ret.none')}</span></div>`;

    renderChart(365);
    document.getElementById('range-btns').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-days]');
      if (!btn) return;
      document.querySelectorAll('#range-btns .btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderChart(Number(btn.dataset.days));
    });

    // Interactive chart — opens a large modal: our own NAV chart (Lightweight
    // Charts, zoom/pan/crosshair) beside a column with TEFAS returns and risk.
    // (TEFAS funds are not on TradingView and NAV has no OHLC, so no candles.)
    const iaBtn = document.getElementById('ia-toggle');
    const iaOverlay = document.getElementById('ia-overlay');
    document.getElementById('ia-title').textContent =
      `${profile.code}${profile.title ? ' · ' + profile.title : ''}`;
    let iaBuilt = false;

    function buildInteractive() {
      UI.interactiveChart(document.getElementById('ia-main'), fullHistory, {
        precision: latest.price < 10 ? 6 : 4,
        benchmarks: [
          { key: 'bist', label: 'BIST 100', symbol: 'XU100.IS', color: UI.COLORS.cyan },
          { key: 'nasdaq', label: 'NASDAQ', symbol: '^IXIC', color: UI.COLORS.violet },
        ],
      });

      let html = '';
      const R = returns || {};
      const rows = [
        [t('ret.1m'), R['1m']], [t('ret.3m'), R['3m']], [t('ret.6m'), R['6m']],
        [t('ret.ytd'), R.ytd], [t('ret.1y'), R['1y']],
        [t('ret.3y'), R['3y']], [t('ret.5y'), R['5y']],
      ].filter(([, v]) => v != null);
      if (rows.length) {
        html += `<div class="ia-side-sec"><div class="ia-side-h">${t('chart.returns')}</div><div class="stat-list">` +
          rows.map(([lbl, v]) => `<div class="row"><span class="k">${lbl}</span><span class="v ${UI.chgClass(v)}">${UI.fmtPctRaw(v, 2)}</span></div>`).join('') +
          `</div></div>`;
      }
      if (risk) {
        html += `<div class="ia-side-sec"><div class="ia-side-h">${t('panel.risk')}</div><div class="stat-list">` +
          [
            [t('r.annvol'), UI.fmtPct(risk.annVolatility), ''],
            [t('r.sharpe'), UI.fmtNum(risk.sharpe), UI.chgClass(risk.sharpe)],
            [t('r.sortino'), UI.fmtNum(risk.sortino), UI.chgClass(risk.sortino)],
            [t('bar.maxdd'), UI.fmtPct(risk.maxDrawdown), ''],
          ].map(([k, v, cls]) => `<div class="row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`).join('') +
          `</div></div>`;
      }
      document.getElementById('ia-side').innerHTML = html;
    }

    iaBtn.addEventListener('click', () => {
      iaOverlay.hidden = false;
      if (!iaBuilt) { buildInteractive(); iaBuilt = true; }
    });
    const closeIA = () => { iaOverlay.hidden = true; };
    document.getElementById('ia-x').addEventListener('click', closeIA);
    iaOverlay.addEventListener('click', (e) => { if (e.target === iaOverlay) closeIA(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeIA(); });

    // Allocation doughnut + legend list (fixed categorical hue order)
    if (allocation && allocation.slices.length) {
      document.getElementById('alloc-date').textContent = allocation.date;
      const top = allocation.slices.slice(0, 7);
      const rest = allocation.slices.slice(7).reduce((s, x) => s + x.pct, 0);
      const labels = [...top.map((s) => s.label), ...(rest > 0.01 ? [t('other')] : [])];
      const values = [...top.map((s) => s.pct), ...(rest > 0.01 ? [rest] : [])];
      new Chart(document.getElementById('alloc-chart'), {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{
            data: values,
            backgroundColor: UI.COLORS.categorical.slice(0, labels.length),
            borderColor: '#0d141c', borderWidth: 2,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (c) => `${c.label}: ${c.parsed.toFixed(2)}%` } },
          },
        },
      });
      document.getElementById('alloc-list').innerHTML = labels.map((l, i) =>
        `<div class="row"><span class="k"><span style="color:${UI.COLORS.categorical[i]}">■</span> ${UI.esc(l)}</span>
         <span class="v">${values[i].toFixed(2)}%</span></div>`).join('');
    } else {
      document.getElementById('alloc-box').innerHTML = `<div class="loading" style="color:var(--faint)">${t('alloc.none')}</div>`;
    }

    // Risk metrics
    if (risk) {
      const riskBars = [
        { label: t('bar.var95'), v: risk.var95Hist },
        { label: t('bar.var99'), v: risk.var99Hist },
        { label: t('bar.cvar95'), v: risk.cvar95 },
        { label: t('bar.dailyvol'), v: risk.dailyVolatility },
        { label: t('bar.maxdd'), v: risk.maxDrawdown },
      ];
      new Chart(document.getElementById('risk-chart'), {
        type: 'bar',
        data: {
          labels: riskBars.map((r) => r.label),
          datasets: [{ data: riskBars.map((r) => r.v * 100), backgroundColor: UI.COLORS.amber, borderRadius: 3, barPercentage: 0.55 }],
        },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (c) => c.parsed.x.toFixed(2) + t('bar.loss') } },
          },
          scales: {
            x: { grid: { color: '#141f2b' }, ticks: { callback: (v) => v + '%' } },
            y: { grid: { display: false }, ticks: { color: '#a9b8c6' } },
          },
        },
      });
      document.getElementById('risk-list').innerHTML = [
        statRow(t('r.annvol'), UI.fmtPct(risk.annVolatility)),
        statRow(t('r.annret'), UI.fmtPct(risk.annReturn), UI.chgClass(risk.annReturn)),
        statRow(t('r.sharpe'), UI.fmtNum(risk.sharpe), UI.chgClass(risk.sharpe)),
        statRow(t('r.sortino'), UI.fmtNum(risk.sortino), UI.chgClass(risk.sortino)),
        statRow(t('r.skew'), UI.fmtNum(risk.skewness)),
        statRow(t('r.kurt'), UI.fmtNum(risk.excessKurtosis)),
        statRow(t('r.obs'), risk.observations),
      ].join('');
    }

    // News: query by fund code + manager prefix of the title
    try {
      const q = `${profile.code} ${String(profile.title).split(' ').slice(0, 3).join(' ')} fonu`;
      const { items } = await API.news(q, 'tr');
      document.getElementById('news').innerHTML = items.length
        ? items.map(UI.newsCard).join('')
        : `<div class="loading" style="color:var(--faint)">${t('news.none')}</div>`;
    } catch (err) {
      document.getElementById('news').innerHTML = `<div class="error-box">${UI.esc(err.message)}</div>`;
    }
  }

  load();
})();
