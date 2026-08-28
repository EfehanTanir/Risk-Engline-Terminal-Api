# Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
# SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

"""VaR geriye dönük testi (backtesting) — model doğrulama katmanı.

Risk motoru bir VaR sayısı üretiyor; bu modül o sayının GERÇEKTEN tuttuğunu
sınıyor. Yöntem, bankaların iç model onayı için uyguladığı standardın aynısı:

1. Kayan pencere (rolling window) ile HER GÜN için bir VaR tahmini üretilir.
   Tahmin yalnızca o güne kadarki veriyle yapılır — geleceğe bakış yoktur.
2. Gerçekleşen getiri tahmini aşarsa "ihlal" (exception) sayılır.
3. İhlal sayısı üç sınavdan geçirilir:
      · Kupiec POF   — ihlal SAYISI doğru mu?            (koşulsuz kapsama)
      · Christoffersen — ihlaller KÜMELENİYOR mu?         (bağımsızlık)
      · Koşullu kapsama — ikisinin birleşimi
4. Basel trafik ışığı: yeşil / sarı / kırmızı bölge ve sermaye çarpanı.

Referans: BCBS, "Supervisory framework for the use of backtesting in
conjunction with the internal models approach" (Ocak 1996) ve FRTB'nin
sürdürdüğü aynı 250 gün / %99 çerçevesi.

Bilinçli tercihler:
  · Ağırlıklar test boyunca sabit tutulur (günlük yeniden dengeleme varsayımı).
  · VaR pozitif kayıp oranı olarak raporlanır (0.023 = %2,3 kayıp) — projenin
    geri kalanıyla aynı sözleşme.
  · Trafik ışığı bölgeleri sabit tablodan değil, Basel'in TANIMINDAN
    (binom kuyruk olasılığı) hesaplanır; bkz. basel_zone().
"""
from __future__ import annotations

import math
from statistics import NormalDist
from typing import Optional

import numpy as np

# RiskMetrics'in günlük veri için önerdiği sönüm katsayısı.
EWMA_LAMBDA = 0.94

# Basel 1996 eki: 250 gün / %99 için ihlal sayısına bağlı sermaye ek çarpanı.
# Yalnızca bu parametrelerde anlamlıdır, başka güven düzeyinde uygulanmaz.
_BASEL_PLUS = {5: 0.40, 6: 0.50, 7: 0.65, 8: 0.75, 9: 0.85}


# ---- yardımcı dağılım fonksiyonları --------------------------------------
# scipy bağımlılığı eklemiyoruz: serverless paket boyutu ve soğuk başlangıç
# süresi kritik. İhtiyacımız olan iki ki-kare kuyruğu kapalı formda var.

def _chi2_sf(x: float, df: int) -> float:
    """Ki-kare sağ kuyruk olasılığı. Yalnızca df=1 ve df=2 gerekiyor."""
    if x <= 0:
        return 1.0
    if df == 1:
        return math.erfc(math.sqrt(x / 2.0))
    if df == 2:
        return math.exp(-x / 2.0)
    raise ValueError("df must be 1 or 2")


def _log_binom_pmf(k: int, n: int, p: float) -> float:
    """log C(n,k) p^k (1-p)^(n-k) — logaritmada, taşma/alt taşma olmasın."""
    if k < 0 or k > n:
        return -math.inf
    log_c = math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)
    term_p = k * math.log(p) if k else 0.0
    term_q = (n - k) * math.log1p(-p) if n - k else 0.0
    return log_c + term_p + term_q


def binom_cdf(k: int, n: int, p: float) -> float:
    """P(X <= k), X ~ Binom(n, p)."""
    if k < 0:
        return 0.0
    if k >= n:
        return 1.0
    return float(min(1.0, sum(math.exp(_log_binom_pmf(i, n, p)) for i in range(k + 1))))


# ---- istatistiksel sınavlar ----------------------------------------------

def kupiec_pof(n: int, x: int, p: float) -> dict:
    """Kupiec koşulsuz kapsama (proportion of failures) testi.

    H0: gerçek ihlal oranı = 1 - güven düzeyi.
    LR = -2 ln [ L(p) / L(x/n) ]  ~  khi-kare(1)

    x = 0 veya x = n uç durumlarında 0·ln(0) = 0 sözleşmesi uygulanır.
    """
    if n <= 0:
        return {"lr": None, "pValue": None, "reject": None}
    pi = x / n
    ll_null = (n - x) * math.log1p(-p) + (x * math.log(p) if x else 0.0)
    ll_alt = ((n - x) * math.log1p(-pi) if x < n else 0.0) + (x * math.log(pi) if x else 0.0)
    lr = max(0.0, -2.0 * (ll_null - ll_alt))
    pv = _chi2_sf(lr, 1)
    return {"lr": lr, "pValue": pv, "reject": bool(pv < 0.05)}


def christoffersen_independence(flags: np.ndarray) -> dict:
    """Christoffersen bağımsızlık testi (Markov zinciri, 1. derece).

    İhlal sayısı doğru olsa bile arka arkaya gelmeleri modelin oynaklık
    kümelenmesini yakalayamadığını gösterir — pratikte asıl tehlike budur.
    LR ~ khi-kare(1).
    """
    f = np.asarray(flags, dtype=int)
    if f.size < 2:
        return {"lr": None, "pValue": None, "reject": None}
    prev, cur = f[:-1], f[1:]
    n00 = int(np.sum((prev == 0) & (cur == 0)))
    n01 = int(np.sum((prev == 0) & (cur == 1)))
    n10 = int(np.sum((prev == 1) & (cur == 0)))
    n11 = int(np.sum((prev == 1) & (cur == 1)))
    total = n00 + n01 + n10 + n11
    if total == 0 or (n01 + n11) == 0:
        # Hiç ihlal yoksa bağımsızlık sınavı boş kümede tanımsız kalır.
        return {"lr": None, "pValue": None, "reject": None,
                "transitions": {"n00": n00, "n01": n01, "n10": n10, "n11": n11}}

    pi = (n01 + n11) / total
    pi01 = n01 / (n00 + n01) if (n00 + n01) else 0.0
    pi11 = n11 / (n10 + n11) if (n10 + n11) else 0.0

    def _term(count: int, prob: float) -> float:
        # 0·ln(0) = 0; olasılık 1 ise ln(1) = 0.
        return count * math.log(prob) if count and prob > 0 else 0.0

    ll_null = _term(n00 + n10, 1 - pi) + _term(n01 + n11, pi)
    ll_alt = (_term(n00, 1 - pi01) + _term(n01, pi01)
              + _term(n10, 1 - pi11) + _term(n11, pi11))
    lr = max(0.0, -2.0 * (ll_null - ll_alt))
    pv = _chi2_sf(lr, 1)
    return {"lr": lr, "pValue": pv, "reject": bool(pv < 0.05),
            "transitions": {"n00": n00, "n01": n01, "n10": n10, "n11": n11}}


def basel_zone(n: int, x: int, p: float, conf: float) -> dict:
    """Basel trafik ışığı bölgesi ve sermaye çarpanı.

    Bölge, ezber tablodan değil Basel'in kendi TANIMINDAN hesaplanır:
    gözlenen kadar veya daha az ihlalin binom kümülatif olasılığı
        < %95        → yeşil
        %95 – %99.99 → sarı
        >= %99.99    → kırmızı
    250 gün / %99 için bu tanım bilinen 0-4 / 5-9 / 10+ tablosunu birebir
    üretir; başka n değerlerinde de doğru şekilde ölçeklenir.

    Sermaye çarpanı (3.0 + ek) YALNIZCA %99'da döndürülür — Basel'in ek
    çarpan tablosu o güven düzeyi için kalibre edilmiştir; %95'te uygulamak
    sayıyı anlamsız kılardı.
    """
    cum = binom_cdf(x, n, p)
    zone = "green" if cum < 0.95 else ("yellow" if cum < 0.9999 else "red")
    plus: Optional[float] = None
    if abs(conf - 0.99) < 1e-9:
        plus = 0.0 if x <= 4 else _BASEL_PLUS.get(x, 1.0)
    return {
        "zone": zone,
        "cumulativeProbability": cum,
        "plusFactor": plus,
        "multiplier": (3.0 + plus) if plus is not None else None,
        "calibrated": bool(plus is not None and n == 250),
    }


# ---- VaR tahmin üreticileri ----------------------------------------------

def _forecast_historical(hist: np.ndarray, conf: float) -> float:
    return float(-np.quantile(hist, 1.0 - conf))


def _forecast_parametric(hist: np.ndarray, z: float) -> float:
    return float(-(hist.mean() - z * hist.std(ddof=1)))


def _ewma_sigma(returns: np.ndarray, seed_window: int) -> np.ndarray:
    """Her t için, t-1'e kadarki bilgiyle kurulmuş EWMA oynaklığı.

    sigma2[t] = λ·sigma2[t-1] + (1-λ)·r[t-1]²   (RiskMetrics, sıfır ortalama)
    Dönen dizi returns ile aynı boyda; sigma[t] t gününü TAHMİN eder.
    """
    n = returns.size
    sigma2 = np.empty(n, dtype=float)
    seed = float(np.var(returns[:seed_window], ddof=1)) if seed_window > 1 else float(np.var(returns))
    sigma2[0] = seed
    for t in range(1, n):
        sigma2[t] = EWMA_LAMBDA * sigma2[t - 1] + (1.0 - EWMA_LAMBDA) * returns[t - 1] ** 2
    return np.sqrt(sigma2)


# ---- ana çalıştırıcı ------------------------------------------------------

def run(returns: np.ndarray, dates: list[str], conf: float, window: int,
        max_test: int = 250) -> dict:
    """Tek bir portföy getiri serisi üzerinde üç yöntemi birden test eder.

    returns : günlük basit getiriler (kronolojik)
    dates   : returns ile aynı uzunlukta ISO tarih listesi
    window  : kayan tahmin penceresi (gözlem sayısı)
    max_test: test edilecek gün sayısı tavanı (Basel standardı 250)
    """
    r = np.asarray(returns, dtype=float)
    n_total = r.size
    test_n = min(n_total - window, max_test)
    if test_n < 30:
        raise ValueError(
            f"Backtest icin yeterli gecmis yok: {n_total} gunluk seri, "
            f"{window} gunluk pencere sonrasi yalnizca {max(0, n_total - window)} "
            "gun test edilebiliyor (en az 30 gerekli)."
        )

    start = n_total - test_n
    z = NormalDist().inv_cdf(conf)
    p = 1.0 - conf
    ewma_sigma = _ewma_sigma(r, window)

    var_hist, var_param, var_ewma = [], [], []
    for i in range(start, n_total):
        # i gününü tahmin ederken YALNIZCA [i-window, i) kullanılır.
        past = r[i - window:i]
        var_hist.append(_forecast_historical(past, conf))
        var_param.append(_forecast_parametric(past, z))
        var_ewma.append(float(z * ewma_sigma[i]))

    actual = r[start:]
    test_dates = list(dates[start:])

    methods = {}
    for key, forecasts in (("historical", var_hist), ("parametric", var_param),
                           ("ewma", var_ewma)):
        v = np.asarray(forecasts, dtype=float)
        flags = actual < -v                       # ihlal: kayıp VaR'ı aştı
        idx = [int(i) for i in np.nonzero(flags)[0]]
        x = len(idx)

        excess = (-v - actual)[flags] if x else np.array([])
        # arka arkaya en uzun ihlal serisi
        streak = best = 0
        for f in flags:
            streak = streak + 1 if f else 0
            best = max(best, streak)

        methods[key] = {
            "var": [float(val) for val in v],
            "breaches": idx,
            "stats": {
                "observations": int(test_n),
                "exceptions": x,
                "expected": float(test_n * p),
                "rate": float(x / test_n),
                "kupiec": kupiec_pof(test_n, x, p),
                "independence": christoffersen_independence(flags),
                "basel": basel_zone(test_n, x, p, conf),
                "worstExcess": float(excess.max()) if excess.size else None,
                "avgExcess": float(excess.mean()) if excess.size else None,
                "maxConsecutive": int(best),
                "avgVar": float(v.mean()),
            },
        }
        # Koşullu kapsama = Kupiec + bağımsızlık, khi-kare(2).
        uc = methods[key]["stats"]["kupiec"]["lr"]
        ind = methods[key]["stats"]["independence"]["lr"]
        if uc is not None and ind is not None:
            cc = uc + ind
            cc_p = _chi2_sf(cc, 2)
            methods[key]["stats"]["conditional"] = {
                "lr": cc, "pValue": cc_p, "reject": bool(cc_p < 0.05)}
        else:
            methods[key]["stats"]["conditional"] = {"lr": None, "pValue": None, "reject": None}

    return {
        "dates": test_dates,
        "returns": [float(x) for x in actual],
        "methods": methods,
        "window": {
            "estimation": int(window),
            "test": int(test_n),
            "seriesStart": dates[0],
            "testStart": test_dates[0],
            "end": test_dates[-1],
        },
    }
