// Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
// SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

// F5 Market Map: stocks grouped by sector, split around a center axis
// (losers left, gainers right), colored by daily change. Market switch
// (BIST / NASDAQ / Europe / Asia) + 60s auto-refresh. Over /api/heatmap.
(function () {
  const t = I18N.t.bind(I18N);
  const box = document.getElementById('heatmap');
  const REFRESH_MS = 60_000;
  let market = localStorage.getItem('finansla_heatmap_market') || 'bist';
  let timer = null;

  // Diverging polarity scale: red (down) → neutral → green (up). Saturates at ±4%.
  function heatColor(pct) {
    const x = Math.max(-1, Math.min(1, pct / 4));
    if (x >= 0) return `rgba(47, 208, 126, ${(0.10 + 0.62 * x).toFixed(2)})`;
    return `rgba(255, 82, 82, ${(0.10 + 0.62 * -x).toFixed(2)})`;
  }

  function tile(s) {
    return `<a class="hm-tile" style="background:${heatColor(s.changePercent)}"
       href="stock.html?symbol=${encodeURIComponent(s.symbol)}"
       title="${UI.esc(s.code)} · ${UI.fmtNum(s.price)}">
      <span class="hm-code">${UI.esc(s.code)}</span>
      <span class="hm-chg">${UI.fmtPctRaw(s.changePercent, 2)}</span>
    </a>`;
  }

  function render(sectors) {
    if (!sectors || !sectors.length) {
      box.innerHTML = `<div class="loading" style="color:var(--faint)">${t('news.none')}</div>`;
      return;
    }
    box.innerHTML = sectors.map((sec) => {
      // Average comes from the backend (over the full sector universe, not just
      // the displayed movers); fall back to the shown tiles if absent.
      const avg = typeof sec.avg === 'number'
        ? sec.avg
        : sec.stocks.reduce((s, x) => s + x.changePercent, 0) / sec.stocks.length;
      // Losers left (most-negative far left → near-zero at center),
      // gainers right (near-zero at center → most-positive far right).
      const losers = sec.stocks.filter((s) => s.changePercent < 0)
        .sort((a, b) => a.changePercent - b.changePercent);
      const gainers = sec.stocks.filter((s) => s.changePercent >= 0)
        .sort((a, b) => a.changePercent - b.changePercent);
      const name = t('sec.' + sec.key);
      return `<section class="hm-sector">
        <div class="hm-head">
          <span>${UI.esc(name)}</span>
          <span class="${UI.chgClass(avg)}">${UI.fmtPctRaw(avg, 2)}</span>
        </div>
        <div class="hm-split">
          <div class="hm-side hm-neg">${losers.map(tile).join('')}</div>
          <div class="hm-axis"></div>
          <div class="hm-side hm-pos">${gainers.map(tile).join('')}</div>
        </div>
      </section>`;
    }).join('');
    document.getElementById('asof').textContent =
      `${t('heat.updated')}: ${new Date().toLocaleTimeString(I18N.lang === 'tr' ? 'tr-TR' : 'en-US')}`;
  }

  async function load() {
    try {
      const { sectors } = await API.heatmap(market);
      render(sectors);
    } catch (err) {
      box.innerHTML = `<div class="error-box">${UI.esc(err.message)}</div>`;
    }
  }

  // Market switch buttons
  const marketsBar = document.getElementById('hm-markets');
  function setActiveBtn() {
    marketsBar.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b.dataset.market === market));
  }
  marketsBar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-market]');
    if (!btn || btn.dataset.market === market) return;
    market = btn.dataset.market;
    localStorage.setItem('finansla_heatmap_market', market);
    setActiveBtn();
    box.innerHTML = `<div class="loading">${t('searching')}</div>`;
    load();
  });

  setActiveBtn();
  load();
  timer = setInterval(load, REFRESH_MS);
  window.addEventListener('beforeunload', () => clearInterval(timer));
})();
