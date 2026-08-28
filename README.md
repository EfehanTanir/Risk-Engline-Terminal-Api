# FINANSLA TERMINAL

A Bloomberg-style finance terminal. Live at **[terminal.finansla.net](https://terminal.finansla.net)**.

Search global + BIST equities (Yahoo Finance) and 1,000+ Turkish mutual funds
(TEFAS), open detail pages with charts, risk metrics and news sentiment, and run a
full portfolio **Risk Engine** (historical / parametric / Monte Carlo VaR, CVaR,
correlation structure, diversification analytics) — then **backtest that VaR
model** the way a bank validates its own: rolling out-of-sample forecasts scored
with Kupiec, Christoffersen and the Basel traffic light. Bilingual (TR/EN) and
mobile-responsive.

## Pages

| Key | Page | What it does |
|---|---|---|
| **F1** | Home | Search equities (BIST · US · Europe · Asia) + TEFAS funds, markets overview, and a *Piyasa Gündemi* headline feed with sentiment-colored ticker chips |
| **F2** | Risk Engine | Two tabs on one portfolio. **Risk Analysis** — VaR three ways (historical · parametric · Monte Carlo, 20k Cholesky-factorized scenarios), CVaR / Expected Shortfall, correlation matrix, diversification & per-asset decomposition. **VaR Backtest** — see below |
| **F3** | Compare | Up to 4 assets on one indexed-to-100 chart with side-by-side risk metrics and correlations |
| **F4** | Screener | Filter and rank 1,000+ TEFAS funds by category, risk value and period returns |
| **F5** | Heatmap | Per-sector top gainers/losers scanned over a broad universe across BIST · NASDAQ · Europe · Asia, 60s auto-refresh |
| **F6** | FX & Gold | Live FX rates and gram · quarter · half · full gold, from the Turkish free market or global spot (user's choice), with a converter and calculator |
| **F7** | Crypto Depth | Live crypto order-book depth (sibling project, [derinlik.finansla.net](https://derinlik.finansla.net)) |

### VaR backtesting — model validation (F2, second tab)

A VaR number is a promise. This tab checks whether the promise held.

For every day in the test period a fresh VaR is estimated from the **preceding
window only** — the model never sees the day it is forecasting, so there is no
look-ahead bias. Realized losses that breach the forecast are counted as
exceptions and put through the standard supervisory tests:

- **Kupiec POF** — unconditional coverage: is the *number* of exceptions
  consistent with the confidence level? Likelihood ratio, χ²(1).
- **Christoffersen** — independence: are exceptions *clustered*? A model can get
  the count right and still fail here, and clustering is the failure that
  actually costs money. Markov-chain likelihood ratio, χ²(1).
- **Conditional coverage** — the two combined, χ²(2).
- **Basel traffic light** — green / yellow / red zone and the capital multiplier
  a supervisor would apply. Zones are computed from the **binomial tail
  probability** (Basel's own definition) rather than the hard-coded 0-4 / 5-9 /
  10+ table, so they reproduce that table exactly at 250 days *and* stay correct
  at other test lengths.

Three models are backtested side by side on the same portfolio — historical
simulation, parametric (delta-normal) and **EWMA** (RiskMetrics, λ = 0.94) — so
you can watch one pass while another fails. Output: exception chart with breach
markers, model comparison table, traffic light and a dated exception log.

No scipy: the two chi-square tails and the binomial CDF are computed in closed
form / log space with the standard library, keeping the serverless cold start
small.

**Stock detail** — price chart with 1M/3M/6M/1Y ranges plus an interactive
(zoom / pan / crosshair) chart, key statistics, company profile, risk metrics and
Black–Scholes option Greeks, with Google News sentiment.
**Fund detail** — NAV history (static + interactive), AUM / investors, portfolio
allocation doughnut, TEFAS period returns, risk metrics and news.

## Structure

```
Finansla Terminal/
├── backend/     Python FastAPI API
│   ├── app/main.py           routes: search · quotes · stock · fund · funds · news · market-news · heatmap · gold · portfolio · backtest
│   ├── app/risk.py           VaR family, Black-Scholes greeks, Monte Carlo (numpy)
│   ├── app/backtest.py       rolling-window VaR backtest: Kupiec · Christoffersen · Basel traffic light
│   ├── app/gold.py           gold prices from two sources (global spot / Turkish market)
│   ├── app/tefas_client.py   tefas-crawler + TEFAS JSON API (universe · info · allocation)
│   ├── app/yahoo.py          yfinance wrappers (search, quotes, history, batched heatmap)
│   ├── app/news.py           Google News RSS + TR/EN sentiment lexicon
│   ├── app/admin.py          admin API: health probes, analytics, tracking beacon
│   ├── app/totp.py           authenticator-app login (RFC 6238) + signed sessions
│   ├── app/analytics.py      visitor / usage counters (privacy-preserving)
│   ├── app/sitecfg.py        live announcement banner + maintenance mode
│   ├── app/posts.py          article store for the landing site
│   └── app/store.py          optional Upstash Redis over REST
└── frontend/    Static HTML/CSS/JS terminal UI
    ├── index.html   search + markets overview + headlines
    ├── stock.html   equity detail (chart, interactive chart, stats, profile, risk, greeks, news)
    ├── fund.html    TEFAS fund detail (NAV, allocation, returns, risk, news)
    ├── risk.html    portfolio risk + VaR backtesting (two tabs, one portfolio)
    ├── compare.html · screener.html · heatmap.html · kur.html · 404.html
    ├── admin.html   internal dashboard (not linked, token-protected)
    ├── css/terminal.css
    └── js/  (i18n.js TR/EN · ui.js · api.js · per-page logic incl. backtest.js
              · watchlist.js · whatsnew.js · track.js · admin.js)
```

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/search?q=thyao` | Combined equity (Yahoo) + TEFAS fund search |
| `GET /api/quotes?symbols=XU100.IS,USDTRY=X` | Ticker-tape quotes |
| `GET /api/stock?symbol=THYAO.IS` | Quote, profile, 1Y history, risk metrics, beta vs XU100 / S&P 500, Black-Scholes greeks |
| `GET /api/fund?code=NNF` | NAV history, AUM / investors, TEFAS returns, allocation, risk metrics |
| `GET /api/funds` | Full TEFAS fund universe for the screener |
| `GET /api/news?q=...&lang=tr` | Google News RSS + lexicon sentiment (green / red / gray) |
| `GET /api/market-news?lang=tr` | Market headline feed for the home page |
| `GET /api/history?symbol=THYAO.IS&period=1y` | Daily close series for the interactive charts |
| `GET /api/heatmap?market=bist` | Per-sector top movers (bist · us · europe · asia) |
| `GET /api/gold` | Gold and FX from two sources: global spot and the Turkish free market |
| `POST /api/portfolio` | Risk Engine: `{ assets:[{type, id, weight}], confidence, horizonDays }` |
| `POST /api/backtest` | VaR backtest: `{ assets:[…], confidence, estimationWindow }` → rolling forecasts, exceptions, Kupiec / Christoffersen / conditional-coverage statistics and Basel zone for three models |

### Admin — reachable only at `/admin`, see [ADMIN.md](ADMIN.md)

No username and no password: login is a 6-digit TOTP code from an authenticator
app (RFC 6238, stdlib only), exchanged for a short-lived signed session token.

| Endpoint | Auth | Description |
|---|---|---|
| `POST /api/track` | public | Page-view beacon from `js/track.js` |
| `GET /api/site-config` | public | Live announcement banner / maintenance state |
| `POST /api/admin/login` | public | `{"code":"123456"}` → session token |
| `GET · POST /api/admin/site` | session | Publish the banner / toggle maintenance mode |
| `GET /api/admin/health` | session | Yahoo / TEFAS / Google News / gold-spot / gold-TR / storage probes, instance & cache state |
| `GET /api/admin/ping` | session | Session check + security status (rate limiting on/off) |
| `GET /api/admin/stats?days=14` | session | Visitor and usage analytics |
| `POST /api/admin/reset` | session | Clear analytics counters |
| `GET /api/admin/posts` · `GET · POST /api/admin/post` · `POST /api/admin/post/delete` | session | Article editor for the landing site |


## Language & mobile

- The **TR/EN button** in the top bar switches language (default Turkish; the
  choice persists in the browser). Strings live in `frontend/js/i18n.js`.
- Layout is responsive down to small phones: panels stack, touch targets grow,
  inputs use ≥16px font to prevent iOS zoom.

## Notes & assumptions

- **Greeks** are for a *synthetic at-the-money 30-day European option* priced with
  Black-Scholes on 1Y realized volatility (BIST stocks have no liquid listed
  options). Risk-free proxies: 40% TRY, 4.5% USD.
- **Interactive charts** use TradingView Lightweight Charts drawn from our own
  price / NAV data — no third-party data embed.
- **Heatmap** scans a broad curated universe per sector (the biggest companies,
  not every listed stock); quotes are batch-fetched and cached briefly to stay
  within free-tier limits.
- **Backtesting** holds portfolio weights fixed across the test period (daily
  rebalancing assumption) and excludes dividends and transaction costs. The
  Basel capital multiplier is reported only at 99% confidence, where its plus-
  factor table is calibrated; at 95% the zones are still computed correctly from
  the binomial but the multiplier is left undefined rather than misapplied.
- **Gold** is *not* taken from Yahoo's `GC=F`, which is a COMEX futures contract
  trading above spot by the cost of carry (~1.2% measured), not the spot price
  Turkish quotes are derived from. Two dedicated sources are used instead and the
  user picks which one; Turkish free market is the default.
- **TEFAS** history is fetched in chunks and the fund universe cached ~6h; TEFAS
  may rate-limit datacenter IPs. The backtest pulls a longer window
  (~1,000 calendar days) so a 250-day estimation window still leaves a 250-day
  Basel test period.
- **News sentiment** is a TR+EN keyword lexicon heuristic — an indicator, not
  NLP-grade classification.
- Educational use only — not investment advice.

## License

Copyright © 2026 **Efehan Tanırgan**. All rights reserved.

This is proprietary software — see [LICENSE](LICENSE). The repository is public
so the work can be reviewed; that does not grant permission to copy, modify,
redistribute or reuse any part of it. For permission: efehantanirgan7@gmail.com
