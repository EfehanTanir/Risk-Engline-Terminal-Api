# Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
# SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

"""VaR ve Expected Shortfall geriye dönük testi — model doğrulama katmanı.

Risk motoru bir VaR sayısı üretiyor; bu modül o sayının GERÇEKTEN tuttuğunu
sınıyor. Yöntem, bankaların iç model onayı için uyguladığı standardın aynısı:

1. Kayan pencere (rolling window) ile HER GÜN için bir tahmin üretilir.
   Tahmin yalnızca o güne kadarki veriyle yapılır — geleceğe bakış yoktur.
2. Gerçekleşen getiri tahmini aşarsa "ihlal" (exception) sayılır.
3. İhlal sayısı üç sınavdan geçirilir:
      · Kupiec POF   — ihlal SAYISI doğru mu?            (koşulsuz kapsama)
      · Christoffersen — ihlaller KÜMELENİYOR mu?         (bağımsızlık)
      · Koşullu kapsama — ikisinin birleşimi
4. Basel trafik ışığı: yeşil / sarı / kırmızı bölge ve sermaye çarpanı.
5. Expected Shortfall %97,5 ayrıca Acerbi–Székely Z2 ile sınanır.

DÜZENLEME NOTU (sık yanlış bilinir): FRTB sermayeyi ES %97,5 ile ölçer ama
geriye dönük testi HÂLÂ VaR üzerinden yapar. Sebebi teknik: ES "elicitable"
değildir, yani doğrudan skorlanabilir bir istatistik değildir. Acerbi–Székely
(2014) testleri bu boşluğu kapatmak için önerilmiştir, düzenleyici zorunluluk
oldukları için değil. Bu yüzden burada ikisi birlikte raporlanır: VaR
sınavları düzenleyici çerçeveyi, ES sınavı kuyruğun gerçek ağırlığını gösterir.

Referans: BCBS "Supervisory framework for the use of backtesting..." (1996),
BCBS d457 (FRTB, 2019), Acerbi & Székely "Back-testing Expected Shortfall"
(Risk, 2014).

Bilinçli tercihler:
  · Ağırlıklar test boyunca sabit tutulur (günlük yeniden dengeleme varsayımı).
  · VaR/ES pozitif kayıp oranı olarak raporlanır (0.023 = %2,3 kayıp).
  · Trafik ışığı bölgeleri sabit tablodan değil, Basel'in TANIMINDAN
    (binom kuyruk olasılığı) hesaplanır; bkz. basel_zone().
  · Z2'nin p-değeri sabit tohumlu Monte Carlo ile bulunur: aynı portföy aynı
    sonucu versin, kullanıcı sayfayı yenileyince p-değeri oynamasın.
"""
from __future__ import annotations

import math
from statistics import NormalDist
from typing import Optional

import numpy as np

# RiskMetrics'in günlük veri için önerdiği sönüm katsayısı.
EWMA_LAMBDA = 0.94

# FRTB'nin sermaye ölçüsü olarak kullandığı ES düzeyi.
ES_LEVEL = 0.975

# Z2'nin dağılımı kapalı formda yok; simülasyonla bulunuyor.
ES_SIMULATIONS = 2000
ES_SEED = 20260828

# Basel 1996 eki: 250 gün / %99 için ihlal sayısına bağlı sermaye ek çarpanı.
# Yalnızca bu parametrelerde anlamlıdır, başka güven düzeyinde uygulanmaz.
_BASEL_PLUS = {5: 0.40, 6: 0.50, 7: 0.65, 8: 0.75, 9: 0.85}

_ND = NormalDist()


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


def _cdf_table(n: int, p: float) -> list[float]:
    """Tüm k için P(X <= k) — tek geçişte birikimli toplam.

    Aralık ve eşik hesapları binom_cdf'i k kez çağırsa O(n²) olurdu;
    tablo bir kez kurulup üç yerde birden kullanılıyor.
    """
    out, acc = [], 0.0
    for k in range(n + 1):
        acc += math.exp(_log_binom_pmf(k, n, p))
        out.append(min(1.0, acc))
    return out


def binom_interval(cdf: list[float], mass: float = 0.95) -> tuple[int, int]:
    """İhlal sayısının merkezi %95 kabul aralığı.

    "6 ihlal neden sarı?" sorusunun görsel cevabı bu: beklenen 2,5 iken
    0–6 arası normal, 7 ve üstü olağandışı. Kullanıcıya ham p-değerinden
    çok daha anlaşılır geliyor.
    """
    tail = (1.0 - mass) / 2.0
    lo = next((k for k, c in enumerate(cdf) if c >= tail), 0)
    hi = next((k for k, c in enumerate(cdf) if c >= 1.0 - tail), len(cdf) - 1)
    return lo, hi


def basel_thresholds(cdf: list[float]) -> dict:
    """Bölge sınırlarının ihlal sayısı cinsinden karşılığı.

    Kullanıcı "kaç ihlalde sarıya düşerim" diye merak ediyor; bölgeyi
    hesaplayan binom tanımını tersine çevirip söylüyoruz.
    """
    green_max = max((k for k, c in enumerate(cdf) if c < 0.95), default=0)
    yellow_max = max((k for k, c in enumerate(cdf) if c < 0.9999), default=0)
    return {"greenMax": green_max, "yellowMax": yellow_max}


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


# ---- VaR / ES tahmin üreticileri -----------------------------------------

def _forecast_historical(hist: np.ndarray, conf: float) -> tuple[float, float]:
    """Tarihsel simülasyon: ampirik kantil ve o kantilin ötesindeki ortalama."""
    q = float(np.quantile(hist, 1.0 - conf))
    tail = hist[hist <= q]
    es = float(-tail.mean()) if tail.size else float(-q)
    return -q, es


def _forecast_normal(mu: float, sigma: float, conf: float) -> tuple[float, float]:
    """Normal varsayımı altında VaR ve ES (ikisi de pozitif kayıp).

    ES = -mu + sigma · phi(z) / (1 - conf)   — kapalı form, simülasyon yok.
    """
    z = _ND.inv_cdf(conf)
    pdf = math.exp(-0.5 * z * z) / math.sqrt(2.0 * math.pi)
    return -(mu - z * sigma), -mu + sigma * pdf / (1.0 - conf)


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


# ---- Expected Shortfall sınavı (Acerbi–Székely Z2) ------------------------

def _z2_statistic(sample: np.ndarray, var: np.ndarray, es: np.ndarray,
                  p: float) -> np.ndarray:
    """Acerbi–Székely ikinci test istatistiği.

        Z2 = Σ_t [ X_t · 1{X_t < -VaR_t} / (T · p · ES_t) ] + 1

    `sample` tek bir seri (T,) ya da simülasyon yığını (M, T) olabilir.
    Doğru model altında E[Z2] = 0. NEGATİF değerler kuyruk kayıplarının
    tahmin edilen ES'ten büyük olduğunu, yani ES'in RİSKİ AZ GÖSTERDİĞİNİ
    söyler — tehlikeli yön budur, testi tek taraflı okuyoruz.
    """
    x = np.atleast_2d(sample)
    t = x.shape[1]
    # Sıfır oynaklıklı bir pencere (ör. NAV'ı hiç değişmemiş fon) ES'i sıfır
    # yapar ve bölme patlar; taban koyup sonucu sonlu tutuyoruz.
    es_safe = np.maximum(np.asarray(es, dtype=float), 1e-12)
    breach = x < -var
    contrib = np.where(breach, x / (t * p * es_safe), 0.0)
    return contrib.sum(axis=1) + 1.0


def _es_backtest(actual: np.ndarray, var: np.ndarray, es: np.ndarray,
                 p: float, draws: np.ndarray) -> dict:
    """Z2 ve simülasyonla bulunmuş p-değeri.

    Z2'nin dağılımı kapalı formda yok. Acerbi–Székely'nin önerdiği yol:
    modelin KENDİ öngörü dağılımından senaryo üretip Z2'yi orada yeniden
    hesaplamak. `draws` (M, T) o senaryolardır ve her yöntem için kendi
    dağılımından üretilir (bkz. run()).
    """
    obs = float(_z2_statistic(actual, var, es, p)[0])
    sims = _z2_statistic(draws, var, es, p)
    # Tek taraflı: yalnızca "gözlenenden daha kötü" senaryoların payı.
    pv = float(np.mean(sims <= obs))

    flags = actual < -var
    n_exc = int(flags.sum())
    realized_tail = float(-actual[flags].mean()) if n_exc else None
    predicted_tail = float(es[flags].mean()) if n_exc else None
    return {
        "level": None,          # run() dolduruyor
        "z2": obs,
        "pValue": pv,
        "reject": bool(pv < 0.05),
        "exceptions": n_exc,
        "avgEs": float(es.mean()),
        "avgVar": float(var.mean()),
        "realizedTailLoss": realized_tail,
        "predictedTailLoss": predicted_tail,
        # >1 ise gerçekleşen kuyruk kaybı tahmini aşmış demektir.
        "tailRatio": (realized_tail / predicted_tail)
                     if (realized_tail and predicted_tail) else None,
        "simulations": int(draws.shape[0]),
    }


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
    p = 1.0 - conf
    p_es = 1.0 - ES_LEVEL
    ewma_sigma = _ewma_sigma(r, window)
    rng = np.random.default_rng(ES_SEED)

    # Kayan tahminler. Her gün için hem kullanıcının seçtiği düzeyde VaR,
    # hem de FRTB'nin ES düzeyinde (%97,5) VaR+ES üretiliyor.
    keys = ("historical", "parametric", "ewma")
    var = {k: [] for k in keys}
    var_es = {k: [] for k in keys}
    es = {k: [] for k in keys}
    windows = np.empty((test_n, window), dtype=float)   # tarihsel bootstrap için
    mu = np.empty(test_n, dtype=float)
    sd = np.empty(test_n, dtype=float)

    for j, i in enumerate(range(start, n_total)):
        # i gününü tahmin ederken YALNIZCA [i-window, i) kullanılır.
        past = r[i - window:i]
        windows[j] = past
        m, s = float(past.mean()), float(past.std(ddof=1))
        mu[j], sd[j] = m, s

        v, _ = _forecast_historical(past, conf)
        var["historical"].append(v)
        v_es, e_es = _forecast_historical(past, ES_LEVEL)
        var_es["historical"].append(v_es)
        es["historical"].append(e_es)

        v, _ = _forecast_normal(m, s, conf)
        var["parametric"].append(v)
        v_es, e_es = _forecast_normal(m, s, ES_LEVEL)
        var_es["parametric"].append(v_es)
        es["parametric"].append(e_es)

        sig = float(ewma_sigma[i])
        v, _ = _forecast_normal(0.0, sig, conf)
        var["ewma"].append(v)
        v_es, e_es = _forecast_normal(0.0, sig, ES_LEVEL)
        var_es["ewma"].append(v_es)
        es["ewma"].append(e_es)

    actual = r[start:]
    test_dates = list(dates[start:])

    # H0 senaryoları: her yöntem KENDİ öngörü dağılımından çekiliyor.
    # Tarihsel simülasyonun öngörü dağılımı tahmin penceresinin kendisidir,
    # o yüzden pencereden yeniden örnekleme (bootstrap) yapılıyor.
    sig_test = ewma_sigma[start:n_total]          # test günlerinin EWMA sigması
    idx = rng.integers(0, window, size=(ES_SIMULATIONS, test_n))
    draws = {
        "historical": windows[np.arange(test_n), idx],
        "parametric": mu + sd * rng.standard_normal((ES_SIMULATIONS, test_n)),
        "ewma": sig_test * rng.standard_normal((ES_SIMULATIONS, test_n)),
    }

    methods = {}
    for key in keys:
        v = np.asarray(var[key], dtype=float)
        flags = actual < -v                       # ihlal: kayıp VaR'ı aştı
        idx_breach = [int(i) for i in np.nonzero(flags)[0]]
        x = len(idx_breach)

        excess = (-v - actual)[flags] if x else np.array([])
        # arka arkaya en uzun ihlal serisi
        streak = best = 0
        for f in flags:
            streak = streak + 1 if f else 0
            best = max(best, streak)

        es_stats = _es_backtest(actual, np.asarray(var_es[key], dtype=float),
                                np.asarray(es[key], dtype=float), p_es, draws[key])
        es_stats["level"] = ES_LEVEL

        uc = kupiec_pof(test_n, x, p)
        ind = christoffersen_independence(flags)
        if uc["lr"] is not None and ind["lr"] is not None:
            cc = uc["lr"] + ind["lr"]
            cc_p = _chi2_sf(cc, 2)
            conditional = {"lr": cc, "pValue": cc_p, "reject": bool(cc_p < 0.05)}
        else:
            conditional = {"lr": None, "pValue": None, "reject": None}

        methods[key] = {
            "var": [float(val) for val in v],
            "es": [float(val) for val in es[key]],
            "breaches": idx_breach,
            "stats": {
                "observations": int(test_n),
                "exceptions": x,
                "expected": float(test_n * p),
                # Risk yöneticisi bu oranı bir bakışta okur: 2.4x = ciddi sapma.
                "ratio": (x / (test_n * p)) if test_n * p > 0 else None,
                "rate": float(x / test_n),
                "kupiec": uc,
                "independence": ind,
                "conditional": conditional,
                "basel": basel_zone(test_n, x, p, conf),
                "es": es_stats,
                "worstExcess": float(excess.max()) if excess.size else None,
                "avgExcess": float(excess.mean()) if excess.size else None,
                "maxConsecutive": int(best),
                "avgVar": float(v.mean()),
            },
        }

    cdf = _cdf_table(test_n, p)
    lo, hi = binom_interval(cdf, 0.95)
    return {
        "dates": test_dates,
        "returns": [float(x) for x in actual],
        "methods": methods,
        "expectation": {
            "expected": float(test_n * p),
            "ci95": [int(lo), int(hi)],
            **basel_thresholds(cdf),
        },
        "window": {
            "estimation": int(window),
            "test": int(test_n),
            "seriesStart": dates[0],
            "testStart": test_dates[0],
            "end": test_dates[-1],
        },
    }
