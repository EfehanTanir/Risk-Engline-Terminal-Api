// Quantitative risk library: return statistics, VaR family, Black-Scholes greeks,
// correlation/covariance, Cholesky and Monte Carlo simulation.
// Conventions: returns are simple daily returns; VaR/CVaR are reported as POSITIVE
// loss fractions (0.023 = 2.3% one-day loss); 252 trading days per year.

const TRADING_DAYS = 252;

function dailyReturns(prices) {
  const r = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && isFinite(prices[i])) r.push(prices[i] / prices[i - 1] - 1);
  }
  return r;
}

function mean(a) {
  if (!a.length) return 0;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

function skewness(a) {
  const n = a.length;
  if (n < 3) return 0;
  const m = mean(a), s = std(a);
  if (s === 0) return 0;
  return (n / ((n - 1) * (n - 2))) * a.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0);
}

function excessKurtosis(a) {
  const n = a.length;
  if (n < 4) return 0;
  const m = mean(a), s = std(a);
  if (s === 0) return 0;
  const g2 = a.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0) *
    ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) -
    (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return g2;
}

// p in [0,1], on an ASCENDING sorted array, linear interpolation
function percentileSorted(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function historicalVaR(returns, conf = 0.95) {
  const sorted = [...returns].sort((a, b) => a - b);
  return -percentileSorted(sorted, 1 - conf);
}

function cvar(returns, conf = 0.95) {
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoff = percentileSorted(sorted, 1 - conf);
  const tail = sorted.filter((x) => x <= cutoff);
  return tail.length ? -mean(tail) : historicalVaR(returns, conf);
}

// Acklam's inverse normal CDF approximation (relative error < 1.15e-9)
function invNorm(p) {
  if (p <= 0 || p >= 1) return NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function parametricVaR(returns, conf = 0.95) {
  const z = invNorm(conf);
  return -(mean(returns) - z * std(returns));
}

function maxDrawdown(prices) {
  let peak = -Infinity, maxDD = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = 1 - p / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function sharpe(returns, rfAnnual) {
  const annRet = mean(returns) * TRADING_DAYS;
  const annVol = std(returns) * Math.sqrt(TRADING_DAYS);
  return annVol === 0 ? 0 : (annRet - rfAnnual) / annVol;
}

function sortino(returns, rfAnnual) {
  const annRet = mean(returns) * TRADING_DAYS;
  const rfDaily = rfAnnual / TRADING_DAYS;
  const downside = returns.filter((r) => r < rfDaily).map((r) => (r - rfDaily) ** 2);
  const ddVol = Math.sqrt((downside.reduce((s, x) => s + x, 0) / Math.max(returns.length, 1))) * Math.sqrt(TRADING_DAYS);
  return ddVol === 0 ? 0 : (annRet - rfAnnual) / ddVol;
}

function covariance(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - 1);
}

function beta(assetReturns, benchReturns) {
  const v = covariance(benchReturns, benchReturns);
  return v === 0 ? null : covariance(assetReturns, benchReturns) / v;
}

function correlation(a, b) {
  const sa = std(a), sb = std(b);
  return sa === 0 || sb === 0 ? 0 : covariance(a, b) / (sa * sb);
}

function corrMatrix(series) {
  return series.map((a) => series.map((b) => correlation(a, b)));
}

function covMatrix(series) {
  return series.map((a) => series.map((b) => covariance(a, b)));
}

// ---- Black-Scholes ------------------------------------------------------

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCdf(x) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const v = 1 - normPdf(x) * poly;
  return x >= 0 ? v : 1 - v;
}

/**
 * Black-Scholes greeks for a European option.
 * S spot, K strike, T years, r cont. risk-free rate, sigma annual vol.
 * Units: theta per calendar day, vega per 1 vol point (1%), rho per 1% rate move.
 */
function blackScholes({ S, K, T, r, sigma }) {
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return null;
  const sqT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqT);
  const d2 = d1 - sigma * sqT;
  const Nd1 = normCdf(d1), Nd2 = normCdf(d2);
  const disc = Math.exp(-r * T);
  const pdf1 = normPdf(d1);

  const callPrice = S * Nd1 - K * disc * Nd2;
  const putPrice = K * disc * (1 - Nd2) - S * (1 - Nd1);
  const gamma = pdf1 / (S * sigma * sqT);
  const vega = (S * pdf1 * sqT) / 100;
  const callTheta = (-(S * pdf1 * sigma) / (2 * sqT) - r * K * disc * Nd2) / 365;
  const putTheta = (-(S * pdf1 * sigma) / (2 * sqT) + r * K * disc * (1 - Nd2)) / 365;

  return {
    inputs: { S, K, T, r, sigma },
    d1, d2,
    call: { price: callPrice, delta: Nd1, gamma, vega, theta: callTheta, rho: (K * T * disc * Nd2) / 100 },
    put: { price: putPrice, delta: Nd1 - 1, gamma, vega, theta: putTheta, rho: (-K * T * disc * (1 - Nd2)) / 100 },
  };
}

// ---- Monte Carlo --------------------------------------------------------

function cholesky(matrix) {
  const n = matrix.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        const v = matrix[i][i] - sum;
        L[i][j] = Math.sqrt(Math.max(v, 1e-12)); // jitter guard for near-singular matrices
      } else {
        L[i][j] = (matrix[i][j] - sum) / (L[j][j] || 1e-12);
      }
    }
  }
  return L;
}

let _spare = null;
function randNorm() {
  // Box-Muller with spare caching
  if (_spare !== null) { const s = _spare; _spare = null; return s; }
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const mag = Math.sqrt(-2 * Math.log(u));
  _spare = mag * Math.sin(2 * Math.PI * v);
  return mag * Math.cos(2 * Math.PI * v);
}

/**
 * Simulate 1-day portfolio returns under multivariate normal assumption.
 * Returns the array of simulated portfolio returns.
 */
function monteCarloPortfolio(weights, meanVec, covMat, sims = 20000) {
  const n = weights.length;
  const L = cholesky(covMat);
  const out = new Array(sims);
  for (let s = 0; s < sims; s++) {
    const z = new Array(n);
    for (let i = 0; i < n; i++) z[i] = randNorm();
    let port = 0;
    for (let i = 0; i < n; i++) {
      let ri = meanVec[i];
      for (let k = 0; k <= i; k++) ri += L[i][k] * z[k];
      port += weights[i] * ri;
    }
    out[s] = port;
  }
  return out;
}

/**
 * Align several {date -> price} maps on their common dates.
 * Returns { dates, prices: number[][] } (one price array per input series).
 */
function alignSeries(maps) {
  if (!maps.length) return { dates: [], prices: [] };
  let common = Object.keys(maps[0]);
  for (let i = 1; i < maps.length; i++) {
    const keys = new Set(Object.keys(maps[i]));
    common = common.filter((d) => keys.has(d));
  }
  common.sort();
  return { dates: common, prices: maps.map((m) => common.map((d) => m[d])) };
}

function histogram(values, bins = 41) {
  if (!values.length) return { edges: [], counts: [] };
  const min = Math.min(...values), max = Math.max(...values);
  const width = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    let b = Math.floor((v - min) / width);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  const edges = Array.from({ length: bins }, (_, i) => min + i * width + width / 2);
  return { edges, counts };
}

/** Full risk profile from a price series (used by stock & fund pages). */
function riskProfile(prices, rfAnnual, benchReturns = null) {
  const rets = dailyReturns(prices);
  if (rets.length < 20) return null;
  const annVol = std(rets) * Math.sqrt(TRADING_DAYS);
  return {
    observations: rets.length,
    annReturn: mean(rets) * TRADING_DAYS,
    annVolatility: annVol,
    dailyVolatility: std(rets),
    var95Hist: historicalVaR(rets, 0.95),
    var99Hist: historicalVaR(rets, 0.99),
    var95Param: parametricVaR(rets, 0.95),
    var99Param: parametricVaR(rets, 0.99),
    cvar95: cvar(rets, 0.95),
    maxDrawdown: maxDrawdown(prices),
    sharpe: sharpe(rets, rfAnnual),
    sortino: sortino(rets, rfAnnual),
    skewness: skewness(rets),
    excessKurtosis: excessKurtosis(rets),
    beta: benchReturns ? beta(rets, benchReturns) : null,
    riskFreeUsed: rfAnnual,
  };
}

module.exports = {
  TRADING_DAYS, dailyReturns, mean, std, skewness, excessKurtosis,
  percentileSorted, historicalVaR, cvar, parametricVaR, invNorm, maxDrawdown,
  sharpe, sortino, covariance, beta, correlation, corrMatrix, covMatrix,
  normCdf, normPdf, blackScholes, cholesky, randNorm, monteCarloPortfolio,
  alignSeries, histogram, riskProfile,
};
