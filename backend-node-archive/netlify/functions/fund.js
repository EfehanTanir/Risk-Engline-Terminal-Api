// GET /api/fund?code=NNF
// TEFAS fund detail: 1y NAV history, latest AUM/investor stats, category returns,
// portfolio allocation breakdown, and the same risk profile used for stocks.
const { fundHistory, fundAllocation, fundList } = require('../../lib/tefas');
const { json, badRequest, serverError, preflight } = require('../../lib/util');
const risk = require('../../lib/risk');

const RF_TRY = 0.40;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  const code = (event.queryStringParameters || {}).code;
  if (!code) return badRequest('Missing query parameter: code');

  try {
    const [{ title, history }, allocation, list] = await Promise.all([
      fundHistory(code, 380),
      fundAllocation(code).catch(() => null),
      fundList().catch(() => []),
    ]);

    if (!history.length) return badRequest(`No TEFAS data found for fund code "${code.toUpperCase()}"`);

    const listEntry = list.find((f) => f.code === code.toLocaleUpperCase('tr-TR')) || null;
    const latest = history[history.length - 1];
    const prices = history.map((h) => h.price);

    return json(200, {
      profile: {
        code: code.toLocaleUpperCase('tr-TR'),
        title: title || (listEntry && listEntry.title) || code.toUpperCase(),
        category: (listEntry && listEntry.category) || null,
        currency: 'TRY',
      },
      latest: {
        date: latest.date,
        price: latest.price,
        aum: latest.aum,
        investors: latest.investors,
        shares: latest.shares,
      },
      returns: (listEntry && listEntry.returns) || null,
      history: history.map((h) => ({ date: h.date, close: h.price })),
      risk: risk.riskProfile(prices, RF_TRY),
      allocation,
      assumptions: { riskFreeRate: RF_TRY },
    });
  } catch (err) {
    return serverError(err);
  }
};
