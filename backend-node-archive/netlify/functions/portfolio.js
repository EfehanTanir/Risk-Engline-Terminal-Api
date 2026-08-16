// POST /api/portfolio  --  the Risk Engine.
// Body: { assets: [{ type: "stock"|"fund", id: "THYAO.IS", weight: 0.5 }, ...],
//         confidence?: 0.95|0.99, horizonDays?: 1 }
// Aligns 1y daily histories on common dates and reports portfolio VaR three ways
// (historical, parametric/variance-covariance, Monte Carlo with Cholesky-correlated
// normals), CVaR, correlation matrix, per-asset stats, and diversification benefit.
const yahooFinance = require('yahoo-finance2').default;
const { fundHistory } = require('../../lib/tefas');
const { json, badRequest, serverError, preflight } = require('../../lib/util');
const risk = require('../../lib/risk');

const MAX_ASSETS = 10;
const MC_SIMS = 20000;

async function stockPriceMap(symbol) {
  const chart = await yahooFinance.chart(symbol, {
    period1: new Date(Date.now() - 400 * 24 * 3600 * 1000),
    interval: '1d',
  });
  const map = {};
  for (const q of chart.quotes || []) {
    if (isFinite(q.close) && q.close > 0) map[new Date(q.date).toISOString().slice(0, 10)] = q.close;
  }
  return map;
}

async function fundPriceMap(code) {
  const { history } = await fundHistory(code, 380);
  const map = {};
  for (const h of history) map[h.date] = h.price;
  return map;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return badRequest('Use POST with a JSON body');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return badRequest('Invalid JSON body'); }

  const assets = Array.isArray(body.assets) ? body.assets : [];
  if (assets.length < 1) return badRequest('Provide at least one asset');
  if (assets.length > MAX_ASSETS) return badRequest(`Maximum ${MAX_ASSETS} assets`);
  for (const a of assets) {
    if (!a || !a.id || !['stock', 'fund'].includes(a.type)) {
      return badRequest('Each asset needs { type: "stock"|"fund", id, weight }');
    }
  }

  const confidence = body.confidence === 0.99 ? 0.99 : 0.95;
  const horizonDays = Math.min(Math.max(Number(body.horizonDays) || 1, 1), 30);
  const scale = Math.sqrt(horizonDays);

  // Normalize weights (fall back to equal-weight if all zero/absent)
  let weights = assets.map((a) => Math.max(Number(a.weight) || 0, 0));
  const wSum = weights.reduce((s, w) => s + w, 0);
  weights = wSum > 0 ? weights.map((w) => w / wSum) : assets.map(() => 1 / assets.length);

  try {
    const maps = await Promise.all(assets.map((a) =>
      a.type === 'fund' ? fundPriceMap(a.id) : stockPriceMap(a.id)
    ));

    for (let i = 0; i < maps.length; i++) {
      if (Object.keys(maps[i]).length < 30) {
        return badRequest(`Not enough price history for ${assets[i].id}`);
      }
    }

    const { dates, prices } = risk.alignSeries(maps);
    if (dates.length < 60) {
      return badRequest(`Only ${dates.length} overlapping trading days across these assets - need at least 60. Mixing rarely-traded instruments reduces the overlap.`);
    }

    const returnSeries = prices.map((p) => risk.dailyReturns(p));
    const n = returnSeries[0].length;

    // Portfolio daily return series (weights held constant - daily rebalancing assumption)
    const portReturns = new Array(n).fill(0);
    for (let i = 0; i < assets.length; i++) {
      for (let t = 0; t < n; t++) portReturns[t] += weights[i] * returnSeries[i][t];
    }

    // Portfolio index for drawdown
    const portIndex = [100];
    for (const r of portReturns) portIndex.push(portIndex[portIndex.length - 1] * (1 + r));

    const meanVec = returnSeries.map((r) => risk.mean(r));
    const covMat = risk.covMatrix(returnSeries);
    const corrMat = risk.corrMatrix(returnSeries);

    const mcReturns = risk.monteCarloPortfolio(weights, meanVec, covMat, MC_SIMS);
    const mcSorted = [...mcReturns].sort((a, b) => a - b);

    const portVolDaily = risk.std(portReturns);
    const weightedAvgVol = weights.reduce((s, w, i) => s + w * risk.std(returnSeries[i]), 0);

    const perAsset = assets.map((a, i) => ({
      id: a.id,
      type: a.type,
      weight: weights[i],
      annVolatility: risk.std(returnSeries[i]) * Math.sqrt(risk.TRADING_DAYS),
      var95Hist: risk.historicalVaR(returnSeries[i], 0.95),
      annReturn: risk.mean(returnSeries[i]) * risk.TRADING_DAYS,
      corrToPortfolio: risk.correlation(returnSeries[i], portReturns),
    }));

    return json(200, {
      inputs: {
        assets: assets.map((a, i) => ({ id: a.id, type: a.type, weight: weights[i] })),
        confidence, horizonDays,
        window: { start: dates[0], end: dates[dates.length - 1], observations: n },
        mcSimulations: MC_SIMS,
      },
      portfolio: {
        annReturn: risk.mean(portReturns) * risk.TRADING_DAYS,
        annVolatility: portVolDaily * Math.sqrt(risk.TRADING_DAYS),
        sharpe: risk.sharpe(portReturns, 0.40),
        sortino: risk.sortino(portReturns, 0.40),
        maxDrawdown: risk.maxDrawdown(portIndex),
        skewness: risk.skewness(portReturns),
        excessKurtosis: risk.excessKurtosis(portReturns),
        var: {
          historical: risk.historicalVaR(portReturns, confidence) * scale,
          parametric: risk.parametricVaR(portReturns, confidence) * scale,
          monteCarlo: -risk.percentileSorted(mcSorted, 1 - confidence) * scale,
          cvarHistorical: risk.cvar(portReturns, confidence) * scale,
          cvarMonteCarlo: -risk.mean(mcSorted.slice(0, Math.max(1, Math.floor(MC_SIMS * (1 - confidence))))) * scale,
        },
        diversificationBenefit: weightedAvgVol > 0
          ? 1 - portVolDaily / weightedAvgVol
          : 0,
      },
      perAsset,
      correlationMatrix: corrMat,
      histograms: {
        historical: risk.histogram(portReturns, 41),
        monteCarlo: risk.histogram(mcReturns, 61),
      },
      notes: [
        'VaR/CVaR reported as positive loss fractions over the chosen horizon (sqrt-of-time scaling).',
        'Monte Carlo assumes multivariate normal returns with the sample covariance (Cholesky factorization).',
        'Sharpe/Sortino use a 40% TRY risk-free proxy; cross-currency portfolios ignore FX conversion (returns are unitless).',
      ],
    });
  } catch (err) {
    return serverError(err);
  }
};
