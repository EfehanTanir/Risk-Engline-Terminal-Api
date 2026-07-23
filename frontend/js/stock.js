// Stock detail page: quote header, price chart, key stats, company profile with
// read-more, risk metrics (chart + list), Black-Scholes greeks, sentiment news.
(function () {
  const symbol = UI.qs('symbol');
  if (!symbol) { location.replace('index.html'); return; }
  document.title = `${symbol} — FINANSLA TERMINAL`;
  const t = I18N.t.bind(I18N);

  let fullHistory = [];
  let priceChart = null;
  let currency = '';

  function renderChart(days) {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const slice = fullHistory.filter((h) => h.date >= cutoff);
    if (priceChart) priceChart.destroy();
    const first = slice[0]?.close, last = slice[slice.length - 1]?.close;
    const color = last >= first ? UI.COLORS.green : UI.COLORS.red;
    priceChart = UI.priceChart(document.getElementById('price-chart'),
      slice.map((h) => h.date), slice.map((h) => h.close), { color, currency });
  }

  function statRow(k, v, cls = '') {
    return `<div class="row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  }

  async function load() {
    let data;
    try {
      data = await API.stock(symbol);
    } catch (err) {
      document.getElementById('page-loading').outerHTML =
        `<div class="error-box">${UI.esc(symbol)} ${t('err.load')} — ${UI.esc(err.message)}</div>`;
      return;
    }
    const { profile, quote, history, risk, greeks, benchmark } = data;
    currency = profile.currency || '';
    fullHistory = history;

    document.getElementById('page-loading').hidden = true;
    document.getElementById('content').hidden = false;

    // Identity: ticker code with the company's full name underneath
    document.getElementById('sym').textContent = profile.symbol;
    document.getElementById('fullname').textContent = profile.longName;
    document.getElementById('tags').innerHTML = [
      profile.exchange, profile.sector, profile.industry, profile.isTurkish ? 'BIST' : null,
    ].filter(Boolean).map((x) => `<span class="tag">${UI.esc(x)}</span>`).join('');

    const cls = UI.chgClass(quote.change);
    document.getElementById('px').innerHTML = `${UI.fmtNum(quote.price)} <span class="small muted">${UI.esc(currency)}</span>`;
    document.getElementById('px').classList.add(cls);
    document.getElementById('chg').textContent =
      `${quote.change > 0 ? '+' : ''}${UI.fmtNum(quote.change)} (${UI.fmtPctRaw(quote.changePercent)})`;
    document.getElementById('chg').classList.add(cls);
    document.getElementById('asof').textContent =
      `${t('market')} ${quote.marketState || ''} · ${new Date().toLocaleString(I18N.lang === 'tr' ? 'tr-TR' : 'en-US')}`;

    // Key statistics
    document.getElementById('stats').innerHTML = [
      statRow(t('k.open'), UI.fmtNum(quote.open)),
      statRow(t('k.prevclose'), UI.fmtNum(quote.previousClose)),
      statRow(t('k.dayrange'), `${UI.fmtNum(quote.dayLow)} – ${UI.fmtNum(quote.dayHigh)}`),
      statRow(t('k.52w'), `${UI.fmtNum(quote.low52w)} – ${UI.fmtNum(quote.high52w)}`),
      statRow(t('k.volume'), UI.fmtBig(quote.volume)),
      statRow(t('k.avgvol'), UI.fmtBig(quote.avgVolume)),
      statRow(t('k.mktcap'), UI.fmtBig(quote.marketCap, currency)),
      statRow(t('k.pe'), UI.fmtNum(quote.trailingPE)),
      statRow(t('k.eps'), UI.fmtNum(quote.eps)),
      statRow(t('k.pb'), UI.fmtNum(quote.priceToBook)),
      statRow(t('k.divyield'), quote.dividendYield != null ? UI.fmtPct(quote.dividendYield > 1 ? quote.dividendYield / 100 : quote.dividendYield) : '—'),
      statRow(t('k.target'), UI.fmtNum(quote.targetMeanPrice)),
      quote.recommendation ? statRow(t('k.consensus'), UI.esc(quote.recommendation.toUpperCase()), 'amber') : '',
    ].join('');

    // Company profile + read more
    document.getElementById('profile-facts').innerHTML = [
      profile.city || profile.country ? statRow(t('k.hq'), UI.esc([profile.city, profile.country].filter(Boolean).join(', '))) : '',
      profile.employees ? statRow(t('k.employees'), UI.fmtBig(profile.employees)) : '',
      profile.website ? statRow(t('k.web'), `<a class="amber" href="${UI.esc(profile.website)}" target="_blank" rel="noopener">${UI.esc(profile.website.replace(/^https?:\/\/(www\.)?/, ''))}</a>`) : '',
    ].join('');
    const about = document.getElementById('about');
    const readmore = document.getElementById('readmore');
    readmore.textContent = t('readmore');
    if (profile.summary) {
      about.textContent = profile.summary;
      requestAnimationFrame(() => {
        if (about.scrollHeight > about.clientHeight + 4) readmore.hidden = false;
      });
      readmore.addEventListener('click', () => {
        const clamped = about.classList.toggle('clamped');
        readmore.textContent = clamped ? t('readmore') : t('showless');
      });
    } else {
      about.textContent = t('profile.none');
    }

    // Price chart + range switching
    renderChart(365);
    document.getElementById('range-btns').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-days]');
      if (!btn) return;
      document.querySelectorAll('#range-btns .btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderChart(Number(btn.dataset.days));
    });

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
          datasets: [{
            data: riskBars.map((r) => r.v * 100),
            backgroundColor: UI.COLORS.amber, borderRadius: 3,
            barPercentage: 0.55, categoryPercentage: 0.8,
          }],
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
        statRow(`${t('r.beta')} ${UI.esc(benchmark)}`, UI.fmtNum(risk.beta)),
        statRow(t('r.sharpe'), UI.fmtNum(risk.sharpe), UI.chgClass(risk.sharpe)),
        statRow(t('r.sortino'), UI.fmtNum(risk.sortino), UI.chgClass(risk.sortino)),
        statRow(t('r.annret'), UI.fmtPct(risk.annReturn, 2), UI.chgClass(risk.annReturn)),
        statRow(t('r.skew'), UI.fmtNum(risk.skewness)),
        statRow(t('r.kurt'), UI.fmtNum(risk.excessKurtosis)),
        statRow(t('r.var95p'), UI.fmtPct(risk.var95Param)),
        statRow(t('r.obs'), risk.observations),
      ].join('');
    }

    // Greeks
    if (greeks) {
      const g = (side, key, dec = 4) => UI.fmtNum(greeks[side][key], dec);
      document.getElementById('greeks-table').innerHTML = `
        <tr><th></th><th>${t('g.call')}</th><th>${t('g.put')}</th></tr>
        <tr><td>${t('g.price')}</td><td>${g('call', 'price', 2)}</td><td>${g('put', 'price', 2)}</td></tr>
        <tr><td>DELTA Δ</td><td>${g('call', 'delta')}</td><td>${g('put', 'delta')}</td></tr>
        <tr><td>GAMMA Γ</td><td>${g('call', 'gamma', 5)}</td><td>${g('put', 'gamma', 5)}</td></tr>
        <tr><td>VEGA ν</td><td>${g('call', 'vega')}</td><td>${g('put', 'vega')}</td></tr>
        <tr><td>THETA Θ</td><td>${g('call', 'theta')}</td><td>${g('put', 'theta')}</td></tr>
        <tr><td>RHO ρ</td><td>${g('call', 'rho')}</td><td>${g('put', 'rho')}</td></tr>`;
      document.getElementById('greeks-note').textContent = t('greeks.note', {
        K: UI.fmtNum(greeks.inputs.K),
        sigma: UI.fmtPct(greeks.inputs.sigma, 1),
        r: UI.fmtPct(greeks.inputs.r, 1),
      });
    } else {
      document.getElementById('greeks-table').innerHTML =
        `<tr><td class="faint" style="text-align:left">${t('greeks.insufficient')}</td></tr>`;
    }

    // News with sentiment indicator (Turkish stocks -> TR news; else UI language)
    try {
      const newsQuery = profile.isTurkish
        ? `${profile.shortName || profile.longName} hisse`
        : `${profile.longName} stock`;
      const { items } = await API.news(newsQuery, profile.isTurkish ? 'tr' : I18N.lang);
      document.getElementById('news').innerHTML = items.length
        ? items.map(UI.newsCard).join('')
        : `<div class="loading" style="color:var(--faint)">${t('news.none')}</div>`;
    } catch (err) {
      document.getElementById('news').innerHTML = `<div class="error-box">${UI.esc(err.message)}</div>`;
    }
  }

  load();
})();
