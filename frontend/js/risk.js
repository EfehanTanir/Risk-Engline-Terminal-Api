// Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
// SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

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

  // ---- hazır varlıklar -------------------------------------------------

  // Aramada bulunamayan ya da yanlış sonuç veren varlıklar. Hepsi portföy
  // motorunda ÇALIŞIYOR (Yahoo geçmişi var), sadece /api/search bunları
  // döndürmüyor. "gold" araması Gold.com Inc. şirketini getiriyordu.
  //
  // UYARI: GC=F ve BZ=F dolar, XU100.IS lira cinsinden. Motor getirileri
  // birimsiz hesapladığı için karışık portföy çalışır ama kur etkisi
  // dışarıda kalır — sayfadaki motor notlarında bu zaten belirtiliyor.
  const QUICK = [
    { id: 'GC=F',      type: 'stock', key: 'q.gold'   },
    { id: 'SI=F',      type: 'stock', key: 'q.silver' },
    { id: 'USDTRY=X',  type: 'stock', key: 'q.usd'    },
    { id: 'EURTRY=X',  type: 'stock', key: 'q.eur'    },
    { id: 'XU100.IS',  type: 'stock', key: 'q.bist'   },
    { id: 'BZ=F',      type: 'stock', key: 'q.brent'  },
    { id: '^GSPC',     type: 'stock', key: 'q.sp500'  },
    { id: 'BTC-USD',   type: 'stock', key: 'q.btc'    },
  ];

  const quickBox = document.getElementById('quick-assets');
  function renderQuick() {
    quickBox.innerHTML = QUICK.map((q) => {
      const on = assets.some((a) => a.id === q.id);
      return `<button class="btn qa${on ? ' on' : ''}" data-qa="${q.id}"${on ? ' disabled' : ''}>${
        on ? '✓ ' : '+ '}${UI.esc(t(q.key))}</button>`;
    }).join('');
  }
  quickBox.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-qa]');
    if (!btn) return;
    const q = QUICK.find((x) => x.id === btn.dataset.qa);
    if (q) addAsset({ type: q.type, id: q.id, name: t(q.key) });
  });

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
    document.getElementById('pf-share').disabled = assets.length < 1;
    document.getElementById('pf-clear').disabled = assets.length < 1;
    renderQuick();
  }

  // ---- portföyü paylaş -------------------------------------------------

  // Portföy YALNIZCA bağlantıda yaşar; tarayıcıya kaydedilmez.
  // Bu bilinçli bir tercih: risk sayfası her açılışta temiz başlar. Portföyü
  // saklamak isteyen bağlantıyı kopyalayıp kendine gönderir — böylece hangi
  // portföyün saklandığına kullanıcı karar verir, sayfa kendi kafasına göre
  // eski bir listeyi geri getirmez.
  //
  // Sunucuya da hiçbir şey yazılmıyor: saklanan kişisel veri yok.

  /** Portföyü bağlantıya kodlar:  ?p=s~GC%3DF~25,f~NNF~75
   *  Biçim: tür(s|f) ~ sembol ~ ağırlık, virgülle ayrılmış. */
  function encodePortfolio() {
    return assets
      .map((a) => `${a.type === 'fund' ? 'f' : 's'}~${a.id}~${a.weight}`)
      .join(',');
  }

  function decodePortfolio(raw) {
    return String(raw || '').split(',').map((chunk) => {
      const [tc, id, w] = chunk.split('~');
      if (!id) return null;
      const weight = Number(w);
      return {
        type: tc === 'f' ? 'fund' : 'stock',
        id,
        name: id,                       // gerçek ad yalnızca aramada gelir
        weight: isFinite(weight) && weight >= 0 ? weight : 0,
      };
    }).filter(Boolean).slice(0, 10);
  }

  /** Sayfa yalnızca ?p= bağlantısıyla açıldığında portföyü geri kurar.
   *  Bağlantı yoksa boş başlar — istenen davranış bu. */
  function restore() {
    const shared = UI.qs('p');
    if (!shared) return;
    decodePortfolio(shared).forEach((a) => {
      if (!assets.some((x) => x.id === a.id)) assets.push(a);
    });
    if (assets.length) renderAssets();
  }

  const msg = document.getElementById('pf-msg');
  function flash(text) {
    msg.textContent = text;
    setTimeout(() => { msg.textContent = ''; }, 2500);
  }

  document.getElementById('pf-share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?p=${encodeURIComponent(encodePortfolio())}`;
    try {
      await navigator.clipboard.writeText(url);
      flash(t('risk.copied'));
    } catch {
      // Pano izni yoksa (http veya eski tarayıcı) bağlantıyı adres çubuğuna
      // yazalım ki kullanıcı elle kopyalayabilsin.
      history.replaceState(null, '', url);
      flash(t('risk.copyfail'));
    }
  });

  document.getElementById('pf-clear').addEventListener('click', () => {
    assets.length = 0;
    // Adresteki ?p= de temizlensin, yoksa sayfa yenilenince portföy geri gelir.
    history.replaceState(null, '', location.pathname);
    renderAssets();
  });

  document.getElementById('equalize').addEventListener('click', equalize);
  renderAssets();
  restore();

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
