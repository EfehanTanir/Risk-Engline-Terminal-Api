// Thin API client for the Finansla Terminal backend.
const API = {
  async _get(path) {
    const res = await fetch(`${window.FINANSLA.API_BASE}${path}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
    return body;
  },
  search(q) { return this._get(`/search?q=${encodeURIComponent(q)}`); },
  quotes(symbols) { return this._get(`/quotes?symbols=${encodeURIComponent(symbols.join(','))}`); },
  stock(symbol) { return this._get(`/stock?symbol=${encodeURIComponent(symbol)}`); },
  fund(code) { return this._get(`/fund?code=${encodeURIComponent(code)}`); },
  news(q, lang) { return this._get(`/news?q=${encodeURIComponent(q)}&lang=${lang || 'tr'}`); },
  async portfolio(payload) {
    const res = await fetch(`${window.FINANSLA.API_BASE}/portfolio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
    return body;
  },
};
