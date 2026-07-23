// Risk Engine page: build a mixed stock/fund portfolio, POST it to /api/portfolio,
// render VaR tiles, histograms with VaR markers, correlation heatmap, asset table.
(function () {
  const assets = []; // { type, id, name, weight }
  const searchInput = document.getElementById('asset-search');
  const dropdown = document.getElementById('asset-dropdown');
  const listEl = document.getElementById('asset-list');
  const runBtn = document.getElementById('run');
  const t = I18N.t.bind(I18N);
  let histChart = null, mcChart = null;

  // ---- builder ---------------------------------------------------------

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

  function addAsset(r) {
    if (assets.length >= 10) return;
    if (assets.some((a) => a.id === r.id)) return;
    assets.push({ type: r.type, id: r.id, name: r.name, weight: 0 });
    equalize();
  }

  function removeAsset(i) {
    assets.splice(i, 1);
    renderAssets();
  }

  function equalize() {
    const w = assets.length ? +(100 / assets.length).toFixed(2) : 0;
    assets.forEach((a) => { a.weight = w; });
    renderAssets();
  }

  function renderAssets() {
    listEl.innerHTML = assets.map((a, i) => `
      <div class="asset-row">
        <span class="code">${UI.esc(a.id)}</span>
        <span class="name">${UI.esc(a.name)}</span>
        <input type="number" min="0" max="100" step="0.5" value="${a.weight}" data-i="${i}"> <span class="faint">%</span>
        <span class="x" data-x="${i}" title="${t('risk.remove')}">✕</span>
      </div>`).join('') ||
      `<div class="small faint" style="padding:10px 2px">${t('risk.empty')}</div>`;
    listEl.querySelectorAll('input[data-i]').forEach((inp) => {
      inp.addEventListener('input', () => {
        assets[Number(inp.dataset.i)].weight = Number(inp.value) || 0;
        updateTotals();
      });
    });
    listEl.querySelectorAll('[data-x]').forEach((el) => {
      el.addEventListener('click', () => removeAsset(Number(el.dataset.x)));
    });
    updateTotals();
  }

  function updateTotals() {
    const total = assets.reduce((s, a) => s + a.weight, 0);
    document.getElementById('weight-total').innerHTML = assets.length
      ? `${t('risk.total')}: <span class="${Math.abs(total - 100) < 0.5 ? 'up' : 'amber'}">${total.toFixed(1)}%</span> ${t('risk.normnote')}`
      : '';
    runBtn.disabled = assets.length < 1;
  }

  document.getElementById('equalize').addEventListener('click', equalize);
  renderAssets();

  // ---- charts ----------------------------------------------------------

  // Draws vertical markers (e.g. VaR cutoffs) on a histogram at given x-values.
  function markerPlugin(markers, edges) {
    return {
      id: 'varMarkers',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!edges || edges.length < 2) return;
        const binW = edges[1] - edges[0];
        for (const m of markers) {
          const idx = (m.value - edges[0]) / binW;
          if (idx < -0.5 || idx > edges.length - 0.5) continue;
          const x = scales.x.getPixelForValue(Math.max(0, Math.min(edges.length - 1, idx)));
          ctx.save();
          ctx.strokeStyle = m.color;
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = m.color;
          ctx.font = '10px monospace';
          ctx.textAlign = 'left';
          ctx.fillText(m.label, x + 4, chartArea.top + 12);
          ctx.restore();
        }
      },
    };
  }

  function drawHistogram(canvasId, hist, markers, color) {
    const canvas = document.getElementById(canvasId);
    const labels = hist.edges.map((e) => (e * 100).toFixed(2) + '%');
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: hist.counts,
          backgroundColor: hist.edges.map((e) => (e < 0 ? UI.COLORS.red + '99' : color + '99')),
          borderWidth: 0, barPercentage: 1, categoryPercentage: 0.92,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `${t('hist.return')} ${items[0].label}`,
              label: (c) => `${c.parsed.y} ${t('hist.obs')}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 9, maxRotation: 0 } },
          y: { grid: { color: '#141f2b' }, ticks: { precision: 0 } },
        },
      },
      plugins: [markerPlugin(markers, hist.edges)],
    });
  }

  function corrColor(v) {
    // diverging: cool blue (negative) -> dark neutral (0) -> warm amber/red (positive)
    const x = Math.max(-1, Math.min(1, v));
    if (x >= 0) {
      const a = 0.08 + 0.72 * x;
      return `rgba(255, ${Math.round(140 - 60 * x)}, 40, ${a.toFixed(2)})`;
    }
    const a = 0.08 + 0.72 * -x;
    return `rgba(56, 132, 248, ${a.toFixed(2)})`;
  }

  // ---- run -------------------------------------------------------------

  runBtn.addEventListener('click', async () => {
    const status = document.getElementById('run-status');
    runBtn.disabled = true;
    runBtn.textContent = t('risk.running');
    status.innerHTML = `<div class="loading">${t('risk.status')}</div>`;

    try {
      const report = await API.portfolio({
        assets: assets.map((a) => ({ type: a.type, id: a.id, weight: a.weight })),
        confidence: Number(document.getElementById('confidence').value),
        horizonDays: Number(document.getElementById('horizon').value) || 1,
      });
      status.innerHTML = '';
      renderReport(report);
    } catch (err) {
      status.innerHTML = `<div class="error-box">${t('risk.error')} — ${UI.esc(err.message)}</div>`;
      document.getElementById('results').hidden = true;
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = t('risk.run');
    }
  });

  function tile(k, v, s, cls = '') {
    return `<div class="tile"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`;
  }

  function renderReport(rep) {
    const p = rep.portfolio;
    const confPct = (rep.inputs.confidence * 100).toFixed(0);
    const hz = rep.inputs.horizonDays;
    const hzLabel = hz === 1 ? t('day1') : t('dayn', { n: hz });
    const sims = rep.inputs.mcSimulations.toLocaleString(I18N.lang === 'tr' ? 'tr-TR' : 'en-US');

    document.getElementById('results').hidden = false;
    document.getElementById('tiles').innerHTML = [
      tile(`VaR ${confPct}% ${t('tile.hist')}`, UI.fmtPct(p.var.historical), `${hzLabel} · ${t('sub.emp')}`, 'down'),
      tile(`VaR ${confPct}% ${t('tile.param')}`, UI.fmtPct(p.var.parametric), `${hzLabel} · ${t('sub.varcov')}`, 'down'),
      tile(`VaR ${confPct}% ${t('tile.mc')}`, UI.fmtPct(p.var.monteCarlo), `${hzLabel} · ${sims} ${t('sub.sims')}`, 'down'),
      tile(`CVaR ${confPct}%`, UI.fmtPct(p.var.cvarHistorical), `${hzLabel} · ${t('sub.es')}`, 'down'),
      tile(t('tile.annvol'), UI.fmtPct(p.annVolatility), t('tile.portsigma')),
      tile(t('tile.sharpe'), UI.fmtNum(p.sharpe), t('tile.rf'), UI.chgClass(p.sharpe)),
      tile(t('tile.maxdd'), UI.fmtPct(p.maxDrawdown), t('tile.insample'), 'down'),
      tile(t('tile.div'), UI.fmtPct(p.diversificationBenefit), t('tile.divsub'), 'up'),
    ].join('');

    document.getElementById('hist-note').textContent = t('obs.window', {
      n: rep.inputs.window.observations,
      start: rep.inputs.window.start,
      end: rep.inputs.window.end,
    });

    // Histograms with 1-day VaR markers (markers stay in daily units to match the data)
    const dailyScale = Math.sqrt(hz);
    if (histChart) histChart.destroy();
    if (mcChart) mcChart.destroy();
    histChart = drawHistogram('hist-chart', rep.histograms.historical, [
      { value: -p.var.historical / dailyScale, color: UI.COLORS.red, label: `VaR ${confPct}%` },
      { value: -p.var.cvarHistorical / dailyScale, color: '#ff9e9e', label: 'CVaR' },
    ], UI.COLORS.cyan);
    mcChart = drawHistogram('mc-chart', rep.histograms.monteCarlo, [
      { value: -p.var.monteCarlo / dailyScale, color: UI.COLORS.red, label: `VaR ${confPct}%` },
    ], UI.COLORS.violet);

    // Correlation heatmap
    const ids = rep.inputs.assets.map((a) => a.id);
    const M = rep.correlationMatrix;
    document.getElementById('corr').innerHTML = `<table class="corr">
      <tr><th></th>${ids.map((id) => `<th>${UI.esc(id)}</th>`).join('')}</tr>
      ${M.map((row, i) => `<tr><th>${UI.esc(ids[i])}</th>${row.map((v) =>
        `<td style="background:${corrColor(v)};color:${Math.abs(v) > 0.55 ? '#fff' : 'var(--ink)'}">${v.toFixed(2)}</td>`
      ).join('')}</tr>`).join('')}
    </table>
    <div class="small faint" style="margin-top:8px">${t('corr.legend')}</div>`;

    // Per-asset table
    document.getElementById('per-asset').innerHTML = `
      <tr><th>${t('th.asset')}</th><th>${t('th.type')}</th><th>${t('th.weight')}</th><th>${t('th.annvol')}</th><th>${t('th.var')}</th><th>${t('th.annret')}</th><th>${t('th.rho')}</th></tr>
      ${rep.perAsset.map((a) => `<tr>
        <td class="amber">${UI.esc(a.id)}</td>
        <td>${a.type.toUpperCase()}</td>
        <td>${UI.fmtPct(a.weight, 1)}</td>
        <td>${UI.fmtPct(a.annVolatility)}</td>
        <td>${UI.fmtPct(a.var95Hist)}</td>
        <td class="${UI.chgClass(a.annReturn)}">${UI.fmtPct(a.annReturn)}</td>
        <td>${UI.fmtNum(a.corrToPortfolio)}</td>
      </tr>`).join('')}`;

    // Localized engine notes (backend notes are English; render our own)
    document.getElementById('notes').innerHTML =
      [t('note.1'), t('note.2'), t('note.3')].map((n) => `<p>· ${n}</p>`).join('');
    document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
})();
