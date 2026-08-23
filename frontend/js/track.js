// Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
// SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

// Visitor beacon. Loaded on every page; reports one event per page view to
// /api/track so the admin panel can show traffic.
//
// Deliberately defensive: it never blocks rendering, never throws into the
// page, and a dead or cold API is simply ignored. Nothing about the terminal
// depends on this file working.
//
// No cookies and no identifiers are set here — the visitor hash is derived
// server-side from IP + user-agent and is never stored in reversible form.
(function () {
  // Honour Do Not Track. Very few browsers still send it, so the data loss is
  // marginal; delete this block if you'd rather count every visit.
  const dnt = navigator.doNotTrack || window.doNotTrack;
  if (dnt === '1' || dnt === 'yes') { window.FLTrack = { search() {} }; return; }

  const PAGES = {
    'index.html': 'home', '': 'home', '/': 'home',
    'stock.html': 'stock', 'fund.html': 'fund', 'risk.html': 'risk',
    'compare.html': 'compare', 'screener.html': 'screener', 'heatmap.html': 'heatmap',
    'kur.html': 'fx',
  };

  const file = location.pathname.split('/').pop() || 'index.html';
  const page = PAGES[file] || file.replace('.html', '').slice(0, 30) || 'home';

  // The admin dashboard shouldn't appear in its own statistics.
  if (file === 'admin.html') { window.FLTrack = { search() {} }; return; }

  function param(name) {
    try {
      return new URLSearchParams(location.search).get(name) || '';
    } catch { return ''; }
  }

  function send(extra) {
    const base = window.FINANSLA && window.FINANSLA.API_BASE;
    if (!base) return;
    const body = Object.assign({ page, ref: document.referrer || '' }, extra || {});
    try {
      fetch(`${base}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        mode: 'cors',
      }).catch(() => {});
    } catch { /* tracking must never surface an error to the user */ }
  }

  // Detail pages carry their subject in the URL, so top viewed tickers and
  // funds come for free without touching stock.js or fund.js.
  const pageview = {};
  if (page === 'stock') pageview.symbol = param('symbol');
  if (page === 'fund') pageview.fund = param('code');

  // Fire after load so tracking never competes with the first paint or the
  // page's own API calls.
  if (document.readyState === 'complete') send(pageview);
  else window.addEventListener('load', () => send(pageview), { once: true });

  // Called by home.js when a search actually returns something.
  window.FLTrack = {
    search(q) {
      if (q && q.trim().length >= 2) send({ query: q.trim().slice(0, 40) });
    },
  };
})();
