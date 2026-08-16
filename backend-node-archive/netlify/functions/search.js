// GET /api/search?q=thy  ->  { stocks: [...], funds: [...] }
const yahooFinance = require('yahoo-finance2').default;
const { searchFunds } = require('../../lib/tefas');
const { json, badRequest, serverError, preflight } = require('../../lib/util');

const STOCK_TYPES = new Set(['EQUITY', 'ETF', 'INDEX', 'CURRENCY', 'CRYPTOCURRENCY', 'MUTUALFUND']);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  const q = (event.queryStringParameters || {}).q;
  if (!q || q.trim().length < 1) return badRequest('Missing query parameter: q');

  try {
    const [yahoo, funds] = await Promise.all([
      yahooFinance.search(q, { quotesCount: 12, newsCount: 0 }).catch(() => ({ quotes: [] })),
      searchFunds(q, 12).catch(() => []),
    ]);

    const stocks = (yahoo.quotes || [])
      .filter((x) => x.symbol && STOCK_TYPES.has(x.quoteType))
      .map((x) => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        exchange: x.exchDisp || x.exchange || null,
        type: x.quoteType,
        isTurkish: /\.IS$/.test(x.symbol),
      }));

    return json(200, { query: q, stocks, funds });
  } catch (err) {
    return serverError(err);
  }
};
