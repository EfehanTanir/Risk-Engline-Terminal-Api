# FINANSLA TERMINAL

A Bloomberg-style finance terminal: global + BIST equities (Yahoo Finance), Turkish
mutual funds (TEFAS via **tefas-crawler**), Google News with sentiment indicators,
and a portfolio **Risk Engine** (historical / parametric / Monte Carlo VaR, CVaR,
correlation structure, diversification analytics). UI is bilingual (TR/EN) and
mobile-responsive.

```
Finansla Terminal/
├── backend/     Python FastAPI API  (deploy on Render — Netlify cannot run Python)
│   ├── app/main.py           routes: search · quotes · stock · fund · news · portfolio
│   ├── app/risk.py           VaR family, Black-Scholes greeks, Monte Carlo (numpy)
│   ├── app/tefas_client.py   tefas-crawler + fund-universe endpoint, 60-day chunking
│   ├── app/yahoo.py          yfinance wrappers
│   ├── app/news.py           Google News RSS + TR/EN sentiment lexicon
│   ├── requirements.txt · render.yaml · Dockerfile
├── frontend/    Static HTML/CSS/JS terminal UI  (deploy on Netlify → terminal.finansla.net)
│   ├── index.html   search + markets overview
│   ├── stock.html   equity detail (chart, stats, profile, risk, greeks, news)
│   ├── fund.html    TEFAS fund detail (NAV, AUM, allocation, risk, news)
│   ├── risk.html    Portfolio Risk Engine
│   └── js/i18n.js   TR/EN dictionary + language toggle (persists in localStorage)
└── backend-node-archive/   old Node backend — safe to delete
```

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/search?q=thyao` | Combined equity (Yahoo) + TEFAS fund search |
| `GET /api/quotes?symbols=XU100.IS,USDTRY=X` | Ticker-tape quotes |
| `GET /api/stock?symbol=THYAO.IS` | Quote, profile, 1Y history, risk metrics, beta vs XU100/S&P500, Black-Scholes greeks |
| `GET /api/fund?code=NNF` | NAV history, AUM/investors, TEFAS returns, portfolio allocation, risk metrics |
| `GET /api/news?q=...&lang=tr` | Google News RSS + lexicon sentiment (green/red/gray) |
| `POST /api/portfolio` | Risk Engine: `{ assets:[{type:"stock"\|"fund", id, weight}], confidence, horizonDays }` |

## Local development

1. Install [Python 3.11+](https://python.org).
2. Backend:
   ```
   cd backend
   python -m venv .venv
   .venv\Scripts\activate        # Windows
   pip install -r requirements.txt
   uvicorn app.main:app --reload --port 8000
   ```
   Interactive docs at http://localhost:8000/docs
3. Frontend: open `frontend/index.html` with any static server (VS Code Live Server
   works). `js/config.js` automatically targets `http://localhost:8000/api` on localhost.

## Deployment

**Backend → Vercel (free Hobby plan)** — Netlify does not support Python functions.
1. Push this repo to GitHub. On [vercel.com](https://vercel.com): *Add New → Project*,
   import the repo, set **Root Directory = `backend`**. Vercel reads `vercel.json`
   and `api/index.py` and deploys the FastAPI app as a Python serverless function.
2. Note the URL, e.g. `https://finansla-api.vercel.app`.
   (`render.yaml`/`Dockerfile` are kept for Render or any container host as
   alternatives.)

**Frontend → Netlify**
1. Edit `frontend/js/config.js` → set `BACKEND_PROD` to
   `https://<your-project>.vercel.app/api`.
2. Create a Netlify site with **Base directory = `frontend`** (no build command).
3. Domain settings → add `terminal.finansla.net`, create the CNAME at your DNS
   provider pointing to the Netlify site.

## Language & mobile

- The **TR/EN button** in the top bar switches language (default Turkish; the
  choice persists in the browser). Add/adjust strings in `frontend/js/i18n.js`.
- Layout is responsive down to small phones: panels stack, touch targets grow,
  inputs use ≥16px font to prevent iOS zoom.

## Notes & assumptions

- **Greeks** are for a *synthetic at-the-money 30-day European option* priced with
  Black-Scholes using 1Y realized volatility (BIST stocks have no liquid listed
  options). Risk-free proxies: 40% TRY, 4.5% USD — adjust in `backend/app/main.py`.
- **TEFAS** limits history queries to ~3-month windows; the backend fetches 1Y in
  60-day chunks via tefas-crawler and caches the fund universe ~6h. TEFAS may
  rate-limit datacenter IPs; errors surface in the UI.
- **News sentiment** is a TR+EN keyword lexicon heuristic — an indicator, not
  NLP-grade classification.
- Educational use only — not investment advice.
