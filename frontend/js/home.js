// Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
// SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

// Home: instant search across Yahoo equities + TEFAS funds, ticker tape, market cards.
(function () {
  const TAPE_SYMBOLS = ['XU100.IS', 'USDTRY=X', 'EURTRY=X', 'GC=F', 'BZ=F', '^GSPC', '^IXIC', 'BTC-USD'];
  // Clean display names instead of Yahoo's raw (often truncated) titles
  const DISPLAY_NAMES = {
    'XU100.IS': 'BIST 100', 'USDTRY=X': 'USD/TRY', 'EURTRY=X': 'EUR/TRY',
    'GC=F': 'GOLD (ONS)', 'BZ=F': 'BRENT', '^GSPC': 'S&P 500',
    '^IXIC': 'NASDAQ', 'BTC-USD': 'BITCOIN',
  };
  const dispName = (q) => DISPLAY_NAMES[q.symbol] || q.name || q.symbol;
  const input = document.getElementById('search');
  const stocksPanel = document.getElementById('stocks-panel');
  const fundsPanel = document.getElementById('funds-panel');
  const stocksBox = document.getElementById('stocks-results');
  const fundsBox = document.getElementById('funds-results');
  let firstHref = null;

  function stockRow(s) {
    return `<a class="result-row" href="stock.html?symbol=${encodeURIComponent(s.symbol)}">
      <span class="code">${UI.esc(s.symbol)}</span>
      <span class="name">${UI.esc(s.name)}</span>
      <span class="meta">${UI.esc(s.exchange || s.type || '')}</span>
    </a>`;
  }
  function fundRow(f) {
    const r1y = f.returns && f.returns['1y'];
    return `<a class="result-row" href="fund.html?code=${encodeURIComponent(f.code)}">
      <span class="code">${UI.esc(f.code)}</span>
      <span class="name">${UI.esc(f.title)}</span>
      <span class="meta ${r1y > 0 ? 'up' : r1y < 0 ? 'down' : ''}">${r1y != null ? '1Y ' + UI.fmtPctRaw(r1y, 1) : ''}</span>
    </a>`;
  }

  async function runSearch(q) {
    if (!q || q.trim().length < 2) {
      stocksPanel.hidden = fundsPanel.hidden = true;
      firstHref = null;
      return;
    }
    stocksPanel.hidden = fundsPanel.hidden = false;
    stocksBox.innerHTML = fundsBox.innerHTML = `<div class="loading">${I18N.t('searching')}</div>`;
    try {
      const { stocks, funds } = await API.search(q.trim());
      if (window.FLTrack) FLTrack.search(q);   // feeds the admin "top searches"
      stocksBox.innerHTML = stocks.length
        ? stocks.map(stockRow).join('')
        : `<div class="loading" style="color:var(--faint)">${I18N.t('home.noequity')}</div>`;
      fundsBox.innerHTML = funds.length
        ? funds.map(fundRow).join('')
        : `<div class="loading" style="color:var(--faint)">${I18N.t('home.nofund')}</div>`;
      document.getElementById('stocks-count').textContent = stocks.length || '';
      document.getElementById('funds-count').textContent = funds.length || '';
      firstHref = stocks.length
        ? `stock.html?symbol=${encodeURIComponent(stocks[0].symbol)}`
        : funds.length ? `fund.html?code=${encodeURIComponent(funds[0].code)}` : null;
    } catch (err) {
      stocksBox.innerHTML = fundsBox.innerHTML = `<div class="error-box">${UI.esc(err.message)}</div>`;
    }
  }

  const debounced = UI.debounce(runSearch, 320);
  input.addEventListener('input', () => debounced(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && firstHref) location.href = firstHref;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
  });

  // Deep-link support: index.html?q=thyao
  const q0 = UI.qs('q');
  if (q0) { input.value = q0; runSearch(q0); }
  input.focus();

  // Ticker tape + market cards
  (async () => {
    try {
      const { quotes } = await API.quotes(TAPE_SYMBOLS);
      const items = quotes.map((q) => {
        const cls = UI.chgClass(q.changePercent);
        return `<span class="tape-item"><b>${UI.esc(dispName(q))}</b>` +
          `<span class="mono-num">${UI.fmtNum(q.price, q.price < 10 ? 4 : 2)}</span> ` +
          `<span class="${cls} mono-num">${UI.fmtPctRaw(q.changePercent, 2)}</span></span>`;
      }).join('');
      document.getElementById('tape').innerHTML = items + items; // duplicated for seamless loop
      document.getElementById('market-cards').innerHTML = quotes.map((q) => {
        const cls = UI.chgClass(q.changePercent);
        const href = q.symbol.includes('=') || q.symbol.startsWith('^')
          ? null : `stock.html?symbol=${encodeURIComponent(q.symbol)}`;
        const inner = `<div class="sym">${UI.esc(dispName(q))}</div>
          <div class="px ${cls}">${UI.fmtNum(q.price, q.price < 10 ? 4 : 2)}</div>
          <div class="chg ${cls}">${UI.fmtNum(q.change, 2)} (${UI.fmtPctRaw(q.changePercent, 2)})</div>`;
        return href ? `<a class="quote-card" href="${href}">${inner}</a>` : `<div class="quote-card">${inner}</div>`;
      }).join('');
    } catch {
      document.getElementById('tape').innerHTML = `<span class="tape-item faint">${I18N.t('home.tapefail')}</span>`;
    }
  })();

  // Market headlines with clickable ticker chips (color = estimated impact)
  (async () => {
    const box = document.getElementById('market-news');
    try {
      const { items } = await API.marketNews(I18N.lang);
      box.innerHTML = items.length
        ? items.map((item) => {
            const label = (item.sentiment && item.sentiment.label) || 'neutral';
            const chips = (item.tickers || []).map((tk) =>
              `<a class="chip ${label}" href="stock.html?symbol=${encodeURIComponent(tk.symbol)}">${UI.esc(tk.code)}</a>`
            ).join('');
            return `<div class="news-item">
              ${UI.sentimentBadge(item.sentiment)}
              <a class="title" href="${UI.esc(item.link || '#')}" target="_blank" rel="noopener">${UI.esc(item.title)}</a>
              <div class="meta-row">
                <span class="meta">${UI.esc(item.source || '')} · ${UI.timeAgo(item.date)}</span>
                <span class="chips">${chips}</span>
              </div>
            </div>`;
          }).join('')
        : `<div class="loading" style="color:var(--faint)">${I18N.t('news.none')}</div>`;
    } catch (err) {
      box.innerHTML = `<div class="error-box">${UI.esc(err.message)}</div>`;
    }
  })();
})();
