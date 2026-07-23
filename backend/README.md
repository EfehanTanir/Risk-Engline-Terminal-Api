# Finansla Terminal API

Python FastAPI backend for [Finansla Terminal](https://terminal.finansla.net):
Yahoo Finance (yfinance) + TEFAS (tefas-crawler) + Google News sentiment +
portfolio Risk Engine (historical / parametric / Monte Carlo VaR).

Endpoints: `/api/search`, `/api/quotes`, `/api/stock`, `/api/fund`, `/api/news`,
`POST /api/portfolio` — interactive docs at `/docs`.

**Deploy target: Vercel** (free Hobby plan). `vercel.json` + `api/index.py`
adapt the FastAPI app to Vercel's Python runtime; set the project's
*Root Directory* to `backend`. `render.yaml`/`Dockerfile` are included for
Render or any container host as alternatives.

Local run:

```
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```
