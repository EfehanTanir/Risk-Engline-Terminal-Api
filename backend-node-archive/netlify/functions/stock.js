// GET /api/stock?symbol=THYAO.IS
// Full detail payload: profile, live quote, 1y history, risk metrics vs benchmark,
// Black-Scholes greeks for a synthetic 30-day ATM option priced off realized vol.
const yahooFinance = require('yahoo-finance2').default;
const { json, badRequest, serverError, preflight } = require('../../lib/util');
const risk = require('../../lib/risk');

// Simplifying assumptions, surfaced to the UI so they are never hidden
const RF_TRY = 0.40; // proxy for TRY policy/deposit rate
const RF_USD = 0.045;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  const symbol = (event.queryStringParameters || {}).symbol;
  if (!symbol) return badRequest('Missing query parameter: symbol');

  const isTurkish = /\.IS$/i.test(symbol);
  const benchmarkSymbol = isTurkish ? 'XU100.IS' : '^GSPC';
  const rf = isTurkish ? RF_TRY : RF_USD;
  const period1 = new Date(Date.now() - 400 * 24 * 3600 * 1000);

  try {
    const [quote, summary, chart, benchChart] = await Promise.all([
      yahooFinance.quote(symbol),
      yahooFinance.quoteSummary(symbol, {
        modules: ['assetProfile', 'summaryDetail', 'defaultKeyStatistics', 'financialData'],
      }).catch(() => null),
      yahooFinance.chart(symbol, { period1, interval: '1d' }),
      yahooFinance.chart(benchmarkSymbol, { period1, interval: '1d' }).catch(() => null),
    ]);

    const history = (chart.quotes || [])
      .filter((q) => isFinite(q.close) && q.close > 0)
      .map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close }));
    if (history.length < 30) return badRequest(`Not enough price history for ${symbol}`);

    // Align benchmark on the stock's dates before computing beta
    let benchReturns = null;
    let betaAligned = null;
    if (benchChart) {
      const benchMap = {};
      for (const q of benchChart.quotes || []) {
        if (isFinite(q.close) && q.close > 0) benchMap[new Date(q.date).toISOString().slice(0, 10)] = q.close;
      }
      const stockMap = {};
      for (const h of history) stockMap[h.date] = h.close;
      const aligned = risk.alignSeries([stockMap, benchMap]);
      if (aligned.dates.length > 30) {
        const stockRets = risk.dailyReturns(aligned.prices[0]);
        benchReturns = risk.dailyReturns(aligned.prices[1]);
        betaAligned = risk.beta(stockRets, benchReturns);
      }
    }

    const closes = history.map((h) => h.close);
    const riskMetrics = risk.riskProfile(closes, rf);
    if (riskMetrics) riskMetrics.beta = betaAligned;

    // Synthetic ATM 30-day option greeks from realized volatility
    const S = quote.regularMarketPrice;
    const greeks = riskMetrics && S > 0
      ? risk.blackScholes({ S, K: S, T: 30 / 365, r: rf, sigma: riskMetrics.annVolatility })
      : null;

    const profile = (summary && summary.assetProfile) || {};
    const detail = (summary && summary.summaryDetail) || {};
    const stats = (summary && summary.defaultKeyStatistics) || {};
    const fin = (summary && summary.financialData) || {};

    return json(200, {
      profile: {
        symbol: quote.symbol,
        longName: quote.longName || quote.shortName || quote.symbol,
        shortName: quote.shortName || null,
        exchange: quote.fullExchangeName || quote.exchange || null,
        currency: quote.currency || null,
        sector: profile.sector || null,
        industry: profile.industry || null,
        website: profile.website || null,
        city: profile.city || null,
        country: profile.country || null,
        employees: profile.fullTimeEmployees || null,
        summary: profile.longBusinessSummary || null,
        isTurkish,
      },
      quote: {
        price: S ?? null,
        change: quote.regularMarketChange ?? null,
        changePercent: quote.regularMarketChangePercent ?? null,
        previousClose: quote.regularMarketPreviousClose ?? null,
        open: quote.regularMarketOpen ?? null,
        dayHigh: quote.regularMarketDayHigh ?? null,
        dayLow: quote.regularMarketDayLow ?? null,
        high52w: quote.fiftyTwoWeekHigh ?? null,
        low52w: quote.fiftyTwoWeekLow ?? null,
        volume: quote.regularMarketVolume ?? null,
        avgVolume: quote.averageDailyVolume3Month ?? null,
        marketCap: quote.marketCap ?? null,
        trailingPE: quote.trailingPE ?? null,
        forwardPE: quote.forwardPE ?? null,
        eps: quote.epsTrailingTwelveMonths ?? null,
        dividendYield: detail.dividendYield ?? null,
        priceToBook: stats.priceToBook ?? null,
        targetMeanPrice: fin.targetMeanPrice ?? null,
        recommendation: fin.recommendationKey || null,
        marketState: quote.marketState || null,
      },
      history,
      risk: riskMetrics,
      greeks,
      benchmark: benchmarkSymbol,
      assumptions: {
        riskFreeRate: rf,
        note: 'Greeks are for a synthetic at-the-money European option, 30 days to expiry, priced with Black-Scholes using 1y realized volatility.',
      },
    });
  } catch (err) {
    return serverError(err);
  }
};
