// GET /api/quotes?symbols=XU100.IS,USDTRY=X,GC=F  ->  ticker-tape quotes
const yahooFinance = require('yahoo-finance2').default;
const { json, badRequest, serverError, preflight } = require('../../lib/util');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  const raw = (event.queryStringParameters || {}).symbols;
  if (!raw) return badRequest('Missing query parameter: symbols');
  const symbols = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 15);

  try {
    const results = await Promise.all(symbols.map((s) =>
      yahooFinance.quote(s).catch(() => null)
    ));
    const quotes = results.filter(Boolean).map((q) => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice ?? null,
      change: q.regularMarketChange ?? null,
      changePercent: q.regularMarketChangePercent ?? null,
      currency: q.currency || null,
      marketState: q.marketState || null,
    }));
    return json(200, { quotes });
  } catch (err) {
    return serverError(err);
  }
};
