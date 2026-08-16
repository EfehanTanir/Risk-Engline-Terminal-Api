# FINANSLA TERMINAL

A Bloomberg-style finance terminal. Live at **[terminal.finansla.net](https://terminal.finansla.net)**.

Search global + BIST equities (Yahoo Finance) and 1,000+ Turkish mutual funds
(TEFAS), open detail pages with charts, risk metrics and news sentiment, and run a
full portfolio **Risk Engine** (historical / parametric / Monte Carlo VaR, CVaR,
correlation structure, diversification analytics). Bilingual (TR/EN) and
mobile-responsive.

## Pages

| Key | Page | What it does |
|---|---|---|
| **F1** | Home | Search equities (BIST · US · Europe · Asia) + TEFAS funds, markets overview, and a *Piyasa Gündemi* headline feed with sentiment-colored ticker chips |
| **F2** | Risk Engine | Portfolio VaR three ways (historical · parametric · Monte Carlo, 20k Cholesky-factorized scenarios), CVaR / Expected Shortfall, correlation matrix, diversification & per-asset decomposition |
| **F3** | Compare | Up to 4 assets on one indexed-to-100 chart with side-by-side risk metrics and correlations |
| **F4** | Screener | Filter and rank 1,000+ TEFAS funds by category, risk value and period returns |
| **F5** | Heatmap | Per-sector top gainers/losers scanned over a broad universe across BIST · NASDAQ · Europe · Asia, 60s auto-refresh |
| **F6** | Crypto Depth | Live crypto order-book depth (sibling project, [derinlik.finansla.net](https://derinlik.finansla.net)) |

**Stock detail** — price chart with 1M/3M/6M/1Y ranges plus an interactive
(zoom / pan / crosshair) chart, key statistics, company profile, risk metrics and
Black–Scholes option Greeks, with Google News sentiment.
**Fund detail** — NAV history (static + interactive), AUM / investors, portfolio
allocation doughnut, TEFAS period returns, risk metrics and news.

## Structure

```
Finansla Terminal/
├── backend/     Python FastAPI API
│   ├── app/main.py           routes: search · quotes · stock · fund · funds · news · market-news · heatmap · portfolio
│   ├── app/risk.py           VaR family, Black-Scholes greeks, Monte Carlo (numpy)
│   ├── app/tefas_client.py   tefas-crawler + TEFAS JSON API (universe · info · allocation)
│   ├── app/yahoo.py          yfinance wrappers (search, quotes, history, batched heatmap)
│   ├── app/news.py           Google News RSS + TR/EN sentiment lexicon
│   ├── app/admin.py          admin API: health probes, analytics, tracking beacon
│   ├── app/totp.py           authenticator-app login (RFC 6238) + signed sessions
│   ├── app/analytics.py      visitor / usage counters (privacy-preserving)
│   ├── app/sitecfg.py        live announcement banner + maintenance mode
│   └── app/store.py          optional Upstash Redis over REST
└── frontend/    Static HTML/CSS/JS terminal UI
    ├── index.html   search + markets overview + headlines
    ├── stock.html   equity detail (chart, interactive chart, stats, profile, risk, greeks, news)
    ├── fund.html    TEFAS fund detail (NAV, allocation, returns, risk, news)
    ├── risk.html · compare.html · screener.html · heatmap.html
    ├── admin.html   internal dashboard (not linked, token-protected)
    ├── css/terminal.css
    └── js/  (i18n.js TR/EN · ui.js · api.js · per-page logic · whatsnew.js · track.js · admin.js)
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
| `POST /api/portfolio` | Risk Engine: `{ assets:[{type, id, weight}], confidence, horizonDays }` |

### Admin — reachable only at `/admin`, see [ADMIN.md](ADMIN.md)

No username and no password: login is a 6-digit TOTP code from an authenticator
app (RFC 6238, stdlib only), exchanged for a short-lived signed session token.

| Endpoint | Auth | Description |
|---|---|---|
| `POST /api/track` | public | Page-view beacon from `js/track.js` |
| `GET /api/site-config` | public | Live announcement banner / maintenance state |
| `POST /api/admin/login` | public | `{"code":"123456"}` → session token |
| `GET · POST /api/admin/site` | session | Publish the banner / toggle maintenance mode |
| `GET /api/admin/health` | session | Yahoo / TEFAS / Google News / storage probes, instance & cache state |
| `GET /api/admin/stats?days=14` | session | Visitor and usage analytics |
| `POST /api/admin/reset` | session | Clear analytics counters |


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
- **TEFAS** history is fetched in chunks and the fund universe cached ~6h; TEFAS
  may rate-limit datacenter IPs.
- **News sentiment** is a TR+EN keyword lexicon heuristic — an indicator, not
  NLP-grade classification.
- Educational use only — not investment advice.
