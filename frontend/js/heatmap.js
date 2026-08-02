// F5 Market Map: BIST stocks grouped by sector, tiles colored by daily change
// (diverging red→gray→green). Pure frontend over /api/heatmap.
(function () {
  const t = I18N.t.bind(I18N);
  const box = document.getElementById('heatmap');

  // Diverging polarity scale: red (down) → neutral → green (up). Saturates at ±4%.
  function heatColor(pct) {
    const x = Math.max(-1, Math.min(1, pct / 4));
    if (x >= 0) return `rgba(47, 208, 126, ${(0.10 + 0.62 * x).toFixed(2)})`;
    return `rgba(255, 82, 82, ${(0.10 + 0.62 * -x).toFixed(2)})`;
  }

  function tile(s) {
    return `<a class="hm-tile" style="background:${heatColor(s.changePercent)}"
       href="stock.html?symbol=${encodeURIComponent(s.symbol)}"
       title="${UI.esc(s.code)} · ${UI.fmtNum(s.price)} TRY">
      <span class="hm-code">${UI.esc(s.code)}</span>
      <span class="hm-chg">${UI.fmtPctRaw(s.changePercent, 2)}</span>
    </a>`;
  }

  (async () => {
    try {
      const { sectors } = await API.heatmap();
      if (!sectors || !sectors.length) {
        box.innerHTML = `<div class="loading" style="color:var(--faint)">${t('news.none')}</div>`;
        return;
      }
      box.innerHTML = sectors.map((sec) => {
        const avg = sec.stocks.reduce((s, x) => s + x.changePercent, 0) / sec.stocks.length;
        const tiles = sec.stocks.slice().sort((a, b) => b.changePercent - a.changePercent).map(tile).join('');
        return `<section class="hm-sector">
          <div class="hm-head">
            <span>${UI.esc(sec.sector)}</span>
            <span class="${UI.chgClass(avg)}">${UI.fmtPctRaw(avg, 2)}</span>
          </div>
          <div class="hm-grid">${tiles}</div>
        </section>`;
      }).join('');
      document.getElementById('asof').textContent =
        new Date().toLocaleString(I18N.lang === 'tr' ? 'tr-TR' : 'en-US');
    } catch (err) {
      box.innerHTML = `<div class="error-box">${UI.esc(err.message)}</div>`;
    }
  })();
})();
