# Finansla Terminal - https://terminal.finansla.net
# Copyright (c) 2026 Efehan Tanırgan. Tüm hakları saklıdır.
# Bu dosya özel mülkiyettir; izinsiz kopyalanamaz, çoğaltılamaz veya dağıtılamaz.

"""Quantitative risk library: return statistics, the VaR family, Black-Scholes
greeks, correlation structure, Cholesky-based Monte Carlo simulation.

Conventions: simple daily returns; VaR/CVaR reported as POSITIVE loss fractions
(0.023 = 2.3% one-day loss); 252 trading days per year.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def daily_returns(prices: np.ndarray) -> np.ndarray:
    p = np.asarray(prices, dtype=float)
    p = p[np.isfinite(p) & (p > 0)]
    return p[1:] / p[:-1] - 1.0


def historical_var(returns: np.ndarray, conf: float = 0.95) -> float:
    return float(-np.quantile(returns, 1 - conf))


def cvar(returns: np.ndarray, conf: float = 0.95) -> float:
    cutoff = np.quantile(returns, 1 - conf)
    tail = returns[returns <= cutoff]
    return float(-tail.mean()) if tail.size else historical_var(returns, conf)


def parametric_var(returns: np.ndarray, conf: float = 0.95) -> float:
    from statistics import NormalDist
    z = NormalDist().inv_cdf(conf)
    return float(-(returns.mean() - z * returns.std(ddof=1)))


def max_drawdown(prices: np.ndarray) -> float:
    p = np.asarray(prices, dtype=float)
    peaks = np.maximum.accumulate(p)
    return float(np.max(1 - p / peaks))


def sharpe(returns: np.ndarray, rf_annual: float) -> float:
    ann_vol = returns.std(ddof=1) * math.sqrt(TRADING_DAYS)
    if ann_vol == 0:
        return 0.0
    return float((returns.mean() * TRADING_DAYS - rf_annual) / ann_vol)


def sortino(returns: np.ndarray, rf_annual: float) -> float:
    rf_daily = rf_annual / TRADING_DAYS
    downside = np.minimum(returns - rf_daily, 0.0)
    dd_vol = math.sqrt(float((downside ** 2).mean())) * math.sqrt(TRADING_DAYS)
    if dd_vol == 0:
        return 0.0
    return float((returns.mean() * TRADING_DAYS - rf_annual) / dd_vol)


def beta(asset_returns: np.ndarray, bench_returns: np.ndarray) -> Optional[float]:
    n = min(asset_returns.size, bench_returns.size)
    if n < 3:
        return None
    a, b = asset_returns[:n], bench_returns[:n]
    var_b = b.var(ddof=1)
    if var_b == 0:
        return None
    cov = np.cov(a, b, ddof=1)[0, 1]
    return float(cov / var_b)


# ---- Black-Scholes -------------------------------------------------------

def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def black_scholes(S: float, K: float, T: float, r: float, sigma: float) -> Optional[dict]:
    """European option greeks. Units: theta per calendar day, vega per 1 vol
    point (1%), rho per 1% rate move — matching the terminal UI."""
    if not (S > 0 and K > 0 and T > 0 and sigma > 0):
        return None
    sq_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * sq_t)
    d2 = d1 - sigma * sq_t
    nd1, nd2 = _norm_cdf(d1), _norm_cdf(d2)
    disc = math.exp(-r * T)
    pdf1 = _norm_pdf(d1)
    gamma = pdf1 / (S * sigma * sq_t)
    vega = S * pdf1 * sq_t / 100.0
    return {
        "inputs": {"S": S, "K": K, "T": T, "r": r, "sigma": sigma},
        "d1": d1,
        "d2": d2,
        "call": {
            "price": S * nd1 - K * disc * nd2,
            "delta": nd1,
            "gamma": gamma,
            "vega": vega,
            "theta": (-(S * pdf1 * sigma) / (2 * sq_t) - r * K * disc * nd2) / 365.0,
            "rho": K * T * disc * nd2 / 100.0,
        },
        "put": {
            "price": K * disc * (1 - nd2) - S * (1 - nd1),
            "delta": nd1 - 1.0,
            "gamma": gamma,
            "vega": vega,
            "theta": (-(S * pdf1 * sigma) / (2 * sq_t) + r * K * disc * (1 - nd2)) / 365.0,
            "rho": -K * T * disc * (1 - nd2) / 100.0,
        },
    }


# ---- Monte Carlo ---------------------------------------------------------

def monte_carlo_portfolio(weights: np.ndarray, mean_vec: np.ndarray,
                          cov: np.ndarray, sims: int = 20000) -> np.ndarray:
    """Simulated 1-day portfolio returns under a multivariate normal with the
    sample covariance (Cholesky factorization preserves correlations)."""
    n = weights.size
    jitter = 1e-12 * np.eye(n)
    try:
        L = np.linalg.cholesky(cov + jitter)
    except np.linalg.LinAlgError:
        L = np.linalg.cholesky(cov + 1e-8 * np.eye(n))
    z = np.random.default_rng().standard_normal((sims, n))
    asset_returns = mean_vec + z @ L.T
    return asset_returns @ weights


def histogram(values: np.ndarray, bins: int = 41) -> dict:
    counts, edges = np.histogram(values, bins=bins)
    centers = (edges[:-1] + edges[1:]) / 2.0
    return {"edges": [float(x) for x in centers], "counts": [int(c) for c in counts]}


def risk_profile(prices, rf_annual: float, bench_returns: Optional[np.ndarray] = None) -> Optional[dict]:
    """Full risk profile from a price series — same payload keys the UI expects."""
    rets = daily_returns(np.asarray(prices, dtype=float))
    if rets.size < 20:
        return None
    s = pd.Series(rets)
    return {
        "observations": int(rets.size),
        "annReturn": float(rets.mean() * TRADING_DAYS),
        "annVolatility": float(rets.std(ddof=1) * math.sqrt(TRADING_DAYS)),
        "dailyVolatility": float(rets.std(ddof=1)),
        "var95Hist": historical_var(rets, 0.95),
        "var99Hist": historical_var(rets, 0.99),
        "var95Param": parametric_var(rets, 0.95),
        "var99Param": parametric_var(rets, 0.99),
        "cvar95": cvar(rets, 0.95),
        "maxDrawdown": max_drawdown(np.asarray(prices, dtype=float)),
        "sharpe": sharpe(rets, rf_annual),
        "sortino": sortino(rets, rf_annual),
        "skewness": float(s.skew()),
        "excessKurtosis": float(s.kurt()),
        "beta": beta(rets, bench_returns) if bench_returns is not None else None,
        "riskFreeUsed": rf_annual,
    }
