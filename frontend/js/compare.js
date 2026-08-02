// F3 Compare: race up to 4 stocks/funds on an indexed-to-100 chart with
// side-by-side risk metrics and a correlation matrix. Pure frontend — reuses
// the existing /api/stock and /api/fund endpoints.
(function () {
  const t = I18N.t.bind(I18N);
  const MAX_ASSETS = 4;
  const assets = []; // { type, id, name, data: {history, risk, currency} | null, error }
  const searchInput = document.getElementById('asset-search');
  const dropdown = document.getElementById('asset-dropdown');
  let chart = null;
  let rangeDays = 365;

  // ---- search dropdown (same pattern as the risk engine) ----------------

  const doSearch = UI.debounce(async (q) => {
    if (!q || q.trim().length < 2) { dropdown.hidden = true; return; }
    dropdown.innerHTML = `<div class="loading">${t('searching')}</div>`;
    dropdown.hidden = false;
    try {
      const { stocks, funds } = await API.search(q.trim());
      const rows = [
        ...stocks.slice(0, 6).map((s) => ({ type: 'stock', id: s.symbol, name: s.name, meta: s.exchange || 'EQUITY' })),
        ...funds.slice(0, 6).map((f) => ({ type: 'fund', id: f.code, name: f.title, meta: 'TEFAS' })),
      ];
      dropdown.innerHTML = rows.length
        ? rows.map((r, i) => `<div class="result-row" data-i="${i}">
            <span class="code">${UI.esc(r.id)}</span>
            <span class="name">${UI.esc(r.name)}</span>
            <span class="meta">${UI.esc(r.meta)}</span>
          </div>`).join('')
        : `<div class="loading" style="color:var(--faint)">${t('risk.nomatch')}</div>`;
      dropdown.querySelectorAll('[data-i]').forEach((el) => {
        el.addEventListener('click', () => {
          addAsset(rows[Number(el.dataset.i)]);
          dropdown.hidden = true;
          searchInput.value = '';
        });
      });
    } catch (err) {
      dropdown.innerHTML = `<div class="error-box">${UI.esc(err.message)}</div>`;
    }
  }, 320);

  searchInput.addEventListener('input', () => doSearch(searchInput.value));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#asset-dropdown') && e.target !== searchInput) dropdown.hidden = true;
  });

  async function addAsset(r) {
    if (assets.length >= MAX_ASSETS || assets.some((a) => a.id === r.id)) return;
    const slot = { type: r.type, id: r.id, name: r.name, data: null, error: null };
    assets.push(slot);
    renderChips();
    try {
      if (r.type === 'stock') {
        const d = await API.stock(r.id);
        slot.data = { history: d.history, risk: d.risk, currency: d.profile.currency || '' };
      } else {
        const d = await API.fund(r.id);
        slot.data = { history: d.history, risk: d.risk, currency: 'TRY' };
      }
    } catch (err) {
      slot.error = err.message;
    }
    renderChips();
    renderAll();
  }

  function removeAsset(i) {
    assets.splice(i, 1);
    renderChips();
    renderAll();
  }

  function renderChips() {
    const box = document.getElementById('asset-list');
    box.innerHTML = assets.map((a, i) => {
      const color = UI.COLORS.categorical[i];
      const state = a.error ? ' ⚠' : (a.data ? '' : ' …');
      return `<span class="tag" style="border-color:${color};color:${color};font-size:11px;padding:4px 10px" title="${UI.esc(a.error || a.name)}">
        ${UI.esc(a.id)}${state} <span class="x" data-x="${i}" style="cursor:pointer;margin-left:6px">✕</span></span>`;
    }).join('');
    box.querySelectorAll('[data-x]').forEach((el) => {
      el.addEventListener('click', () => removeAsset(Number(el.dataset.x)));
    });
  }

  // ---- math helpers -----------------------------------------------------

  function dailyReturns(vals) {
    const r = [];
    for (let i = 1; i < vals.length; i++) if (vals[i - 1] > 0) r.push(vals[i] / vals[i - 1] - 1);
    return r;
  }
  function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
  function corr(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 3) return 0;
    const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) {
      cov += (a[i] - ma) * (b[i] - mb);
      va += (a[i] - ma) ** 2;
      vb += (b[i] - mb) ** 2;
    }
    return va && vb ? cov / Math.sqrt(va * vb) : 0;
  }
  function corrColor(v) {
    const x = Math.max(-1, Math.min(1, v));
    if (x >= 0) return `rgba(255, ${Math.round(140 - 60 * x)}, 40, ${(0.08 + 0.72 * x).toFixed(2)})`;
    return `rgba(56, 132, 248, ${(0.08 + 0.72 * -x).toFixed(2)})`;
  }

  /** Common dates across all loaded assets, each mapped date -> close. */
  function alignLoaded(loaded, days) {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const maps = loaded.map((a) => {
      const m = {};
      for (const h of a.data.history) if (h.date >= cutoff) m[h.date] = h.close;
      return m;
    });
    let dates = Object.keys(maps[0] || {});
    for (let i = 1; i < maps.length; i++) {
      const keys = new Set(Object.keys(maps[i]));
      dates = dates.filter((d) => keys.has(d));
    }
    dates.sort();
    return { dates, series: maps.map((m) => dates.map((d) => m[d])) };
  }

  // ---- rendering --------------------------------------------------------

  function renderAll() {
    const loaded = assets.filter((a) => a.data && a.data.history && a.data.history.length > 5);
    renderChart(loaded);
    renderCorr(loaded);
    renderMetrics(loaded);
  }

  function renderChart(loaded) {
    if (chart) { chart.destroy(); chart = null; }
    if (!loaded.length) return;
    const { dates, series } = alignLoaded(loaded, rangeDays);
    if (dates.length < 2) return;
    const datasets = loaded.map((a, i) => ({
      label: a.id,
      data: series[i].map((v) => (v / series[i][0]) * 100),
      borderColor: UI.COLORS.categorical[i],
      backgroundColor: UI.COLORS.categorical[i],
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.1, fill: false,
    }));
    chart = new Chart(document.getElementById('comp-chart'), {
      type: 'line',
      data: { labels: dates, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'top', labels: { color: '#d7e0e7' } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}` } },
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
          y: { position: 'right', grid: { color: '#141f2b' } },
        },
      },
    });
  }

  function renderCorr(loaded) {
    const box = document.getElementById('corr');
    if (loaded.length < 2) {
      box.innerHTML = `<div class="small faint">${t('comp.empty')}</div>`;
      return;
    }
    const { series } = alignLoaded(loaded, 365);
    const rets = series.map(dailyReturns);
    const M = rets.map((a) => rets.map((b) => corr(a, b)));
    box.innerHTML = `<table class="corr">
      <tr><th></th>${loaded.map((a) => `<th>${UI.esc(a.id)}</th>`).join('')}</tr>
      ${M.map((row, i) => `<tr><th>${UI.esc(loaded[i].id)}</th>${row.map((v) =>
        `<td style="background:${corrColor(v)};color:${Math.abs(v) > 0.55 ? '#fff' : 'var(--ink)'}">${v.toFixed(2)}</td>`
      ).join('')}</tr>`).join('')}
    </table>
    <div class="small faint" style="margin-top:8px">${t('corr.legend')}</div>`;
  }

  function renderMetrics(loaded) {
    const tbl = document.getElementById('metrics');
    if (!loaded.length) {
      tbl.innerHTML = `<tr><td class="faint" style="text-align:left;padding:14px">${t('comp.empty')}</td></tr>`;
      return;
    }
    const row = (label, fn, cls) => `<tr><td>${label}</td>${loaded.map((a) => {
      const v = fn(a);
      return `<td class="${cls ? cls(a) : ''}">${v}</td>`;
    }).join('')}</tr>`;
    const R = (a) => a.data.risk || {};
    tbl.innerHTML = `
      <tr><th></th>${loaded.map((a, i) =>
        `<th style="color:${UI.COLORS.categorical[i]}">${UI.esc(a.id)}</th>`).join('')}</tr>
      ${row(t('m.price'), (a) => {
        const h = a.data.history;
        return `${UI.fmtNum(h[h.length - 1].close, h[h.length - 1].close < 10 ? 4 : 2)} <span class="faint">${UI.esc(a.data.currency)}</span>`;
      })}
      ${row(t('r.annret'), (a) => UI.fmtPct(R(a).annReturn), (a) => UI.chgClass(R(a).annReturn))}
      ${row(t('r.annvol'), (a) => UI.fmtPct(R(a).annVolatility))}
      ${row(t('r.sharpe'), (a) => UI.fmtNum(R(a).sharpe), (a) => UI.chgClass(R(a).sharpe))}
      ${row(t('r.sortino'), (a) => UI.fmtNum(R(a).sortino), (a) => UI.chgClass(R(a).sortino))}
      ${row(t('bar.var95'), (a) => UI.fmtPct(R(a).var95Hist))}
      ${row(t('bar.cvar95'), (a) => UI.fmtPct(R(a).cvar95))}
      ${row(t('bar.maxdd'), (a) => UI.fmtPct(R(a).maxDrawdown))}
      ${row('BETA', (a) => UI.fmtNum(R(a).beta))}`;
  }

  document.getElementById('range-btns').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-days]');
    if (!btn) return;
    document.querySelectorAll('#range-btns .btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    rangeDays = Number(btn.dataset.days);
    renderAll();
  });

  renderChips();
  renderAll();
})();
