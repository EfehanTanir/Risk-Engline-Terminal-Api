// Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
// SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

// F6 Kur & Altın: canlı döviz kurları, altın değerleri, döviz çevirici,
// altın hesaplayıcı ve 1 yıllık seyir grafiği.
//
// İKİ ALTIN KAYNAĞI — kullanıcı seçer:
//   spot → küresel spot ons; gram ve sarrafiye değerlerini BİZ hesaplarız
//          (has değer: saf altının piyasa karşılığı)
//   tr   → Türk serbest piyasası; gram/çeyrek/tam fiyatları hazır gelir,
//          sarrafiye primi ve alış-satış makası dahildir
//
// Yahoo'nun GC=F sembolü SPOT DEĞİL vadeli kontrattır ("Gold Dec 26") ve
// taşıma maliyeti kadar yüksektir (~%1,2). Bu yüzden yalnızca iki kaynak da
// düşerse yedek olarak kullanılır. Ayrıntı: backend/app/gold.py
(function () {
  const t = I18N.t.bind(I18N);

  const ONS_GRAM = 31.1034768;
  const REFRESH_MS = 60_000;
  const SRC_KEY = 'finansla_gold_source';

  const FX = [
    { sym: 'USDTRY=X', code: 'USD', key: 'cur.usd' },
    { sym: 'EURTRY=X', code: 'EUR', key: 'cur.eur' },
    { sym: 'GBPTRY=X', code: 'GBP', key: 'cur.gbp' },
    { sym: 'CHFTRY=X', code: 'CHF', key: 'cur.chf' },
  ];
  const SYMBOLS = FX.map((f) => f.sym).concat(['GC=F']);

  // Sarrafiye künyeleri. Brüt ağırlıklar Darphane ziynet serisi; 22 ayar =
  // binde 916. Saf altın = brüt × saflık. Sayfadaki künye tablosu da bu
  // diziden üretilir, gösterilen varsayım ile hesap ayrılamaz.
  const GOLD = [
    { key: 'gram',   gross: 1.0000, fine: 1.000, karat: 24 },
    { key: 'ceyrek', gross: 1.7540, fine: 0.916, karat: 22 },
    { key: 'yarim',  gross: 3.5080, fine: 0.916, karat: 22 },
    { key: 'tam',    gross: 7.0160, fine: 0.916, karat: 22 },
    { key: 'cumhur', gross: 7.2160, fine: 0.916, karat: 22 },
  ];
  const pure = (g) => g.gross * g.fine;

  const KARATS = [
    { key: 'k22', karat: 22, fine: 0.916 },
    { key: 'k18', karat: 18, fine: 0.750 },
    { key: 'k14', karat: 14, fine: 0.585 },
  ];

  let quotes = {};   // Yahoo kotasyonları
  let G = null;      // /api/gold yükü
  let gram = null;   // aktif kaynağa göre gram has altın, TL
  let chart = null;
  const histCache = {};
  // Varsayılan TÜRK PİYASASI: ziyaretçilerin çoğu "gram altın kaç para"
  // diye geliyor ve kuyumcudaki fiyatı bekliyor. Has değer (küresel spot)
  // bilinçli bir tercih, o yüzden ikinci sırada.
  let source = localStorage.getItem(SRC_KEY) === 'spot' ? 'spot' : 'tr';

  const el = (id) => document.getElementById(id);
  const usdTry = () => (quotes['USDTRY=X'] || {}).price || null;

  // ---- aktif kaynağın altın verisi --------------------------------------

  /** Seçili kaynağa göre ons fiyatı, gram fiyatı ve açıklama döndürür.
   *  Kaynak yoksa sırayla diğerine, en sonda Yahoo vadeliye düşer. */
  function goldBasis() {
    const usd = usdTry();
    const trOk = G && G.turkish && G.turkish.items && G.turkish.items.gram;
    const spotOk = G && G.spot && G.spot.ounceUsd;

    if (source === 'tr' && trOk) {
      return {
        mode: 'tr',
        ons: G.turkish.ounceUsd,
        gram: G.turkish.items.gram.ask || G.turkish.items.gram.bid,
        note: t('fx.noteTr'),
      };
    }
    if (spotOk && usd) {
      return {
        mode: 'spot',
        ons: G.spot.ounceUsd,
        gram: (G.spot.ounceUsd * usd) / ONS_GRAM,
        note: source === 'tr' ? t('fx.noteFallbackTr') : t('fx.noteSpot'),
      };
    }
    // Son çare: vadeli kontrat. Kullanıcıya açıkça söylüyoruz.
    const gc = quotes['GC=F'];
    if (gc && gc.price && usd) {
      return {
        mode: 'futures',
        ons: gc.price,
        gram: (gc.price * usd) / ONS_GRAM,
        note: t('fx.noteFutures'),
      };
    }
    return null;
  }

  // ---- veri --------------------------------------------------------------

  async function load() {
    try {
      // Altın kaynağı çökse bile kurlar gelsin diye ayrı ayrı bekliyoruz.
      const [q, g] = await Promise.all([
        API.quotes(SYMBOLS),
        API.gold().catch(() => null),
      ]);
      quotes = {};
      (q.quotes || []).forEach((x) => { quotes[x.symbol] = x; });
      if (g) G = g;

      renderFx();
      renderGold();
      fillConverter();
      convert();
      calcGold();

      el('asof').textContent =
        `${t('heat.updated')}: ${new Date().toLocaleTimeString(I18N.lang === 'tr' ? 'tr-TR' : 'en-US')}`;
    } catch (err) {
      el('fx-tiles').innerHTML = `<div class="error-box">${UI.esc(err.message)}</div>`;
    }
  }

  // ---- kartlar -----------------------------------------------------------

  function tile(k, v, s, chgPct) {
    // Renk SADECE yüzdeyi saran span'e verilir, alt satırın tamamına değil.
    // `<div class="s up">` işe yaramaz: `.tile .s` (0,2,0) `.up`'tan (0,1,0)
    // güçlü olduğu için gri kazanır.
    const sub = typeof chgPct === 'number' && isFinite(chgPct)
      ? `<div class="s"><span class="${UI.chgClass(chgPct)}">${UI.fmtPctRaw(chgPct, 2)}</span> · ${UI.esc(s)}</div>`
      : `<div class="s">${UI.esc(s)}</div>`;
    return `<div class="tile"><div class="k">${UI.esc(k)}</div><div class="v">${v}</div>${sub}</div>`;
  }

  function renderFx() {
    const rows = FX.map((f) => {
      const q = quotes[f.sym];
      if (!q || !q.price) return tile(f.code + '/TRY', '—', t('fx.na'));
      return tile(`${f.code}/TRY`, UI.fmtNum(q.price, 4), t(f.key), q.changePercent);
    });
    const usd = quotes['USDTRY=X'], eur = quotes['EURTRY=X'];
    if (usd && eur && usd.price) {
      rows.push(tile('EUR/USD', UI.fmtNum(eur.price / usd.price, 4), t('fx.cross')));
    }
    el('fx-tiles').innerHTML = rows.join('');
  }

  function renderGold() {
    const b = goldBasis();
    if (!b) {
      el('gold-tiles').innerHTML = `<div class="error-box">${t('fx.golderr')}</div>`;
      gram = null;
      return;
    }
    gram = b.gram;

    const rows = [];
    if (b.mode === 'tr') {
      const items = G.turkish.items;
      rows.push(tile(t('fx.ons'), UI.fmtNum(b.ons, 2) + ' $', t('fx.onsub')));
      GOLD.forEach((g) => {
        const it = items[g.key];
        if (!it) return;
        rows.push(tile(
          t('gold.' + g.key),
          UI.fmtNum(it.ask, 2) + ' ₺',
          `${t('fx.bid')} ${UI.fmtNum(it.bid, 2)}`,
          it.changePercent,
        ));
      });
      KARATS.forEach((k) => {
        const it = items[k.key];
        if (!it) return;
        rows.push(tile(
          `${k.karat} ${t('fx.karat')} · 1 g`,
          UI.fmtNum(it.ask, 2) + ' ₺',
          `${t('fx.bid')} ${UI.fmtNum(it.bid, 2)}`,
          it.changePercent,
        ));
      });
    } else {
      // Has değer: ons × kur ÷ 31,1035, sonra saf altın içeriğiyle çarp.
      // Günlük değişim hem onstan hem kurdan gelir: (1+ons%)(1+usd%)−1
      const gc = quotes['GC=F'], usdQ = quotes['USDTRY=X'];
      const oc = gc && typeof gc.changePercent === 'number' ? gc.changePercent : null;
      const uc = usdQ && typeof usdQ.changePercent === 'number' ? usdQ.changePercent : null;
      const gramChg = (oc !== null && uc !== null)
        ? ((1 + oc / 100) * (1 + uc / 100) - 1) * 100 : undefined;

      rows.push(tile(t('fx.ons'), UI.fmtNum(b.ons, 2) + ' $', t('fx.onsub'),
        oc === null ? undefined : oc));
      GOLD.forEach((g) => {
        rows.push(tile(
          t('gold.' + g.key),
          UI.fmtNum(b.gram * pure(g), 2) + ' ₺',
          `${UI.fmtNum(pure(g), 4)} g ${t('fx.puregold')}`,
          gramChg,
        ));
      });
      KARATS.forEach((k) => {
        rows.push(tile(
          `${k.karat} ${t('fx.karat')} · 1 g`,
          UI.fmtNum(b.gram * k.fine, 2) + ' ₺',
          `${t('fx.purity')} ${Math.round(k.fine * 1000)}/1000`,
          gramChg,
        ));
      });
    }

    el('gold-tiles').innerHTML = rows.join('');
    el('src-note').textContent = b.note;

    // Başlık ve alt not kaynağa göre değişmeli: Türk piyasası modunda
    // gösterilen değerler "has değer" değil, prim dahil piyasa fiyatıdır.
    el('gold-title').innerHTML = t(b.mode === 'tr' ? 'fx.goldTr' : 'fx.gold');
    el('gold-note').innerHTML = t(b.mode === 'tr' ? 'fx.goldnoteTr' : 'fx.goldnote');
    el('gold-basis').textContent = b.mode === 'tr'
      ? t('fx.basisTr')
      : `ONS ${UI.fmtNum(b.ons, 0)} $ × USD/TRY ${UI.fmtNum(usdTry(), 4)} ÷ ${ONS_GRAM}`;

    // Seçim kullanılabilir değilse düğmeyi gerçeğe uydur
    el('fx-src').querySelectorAll('button').forEach((btn) =>
      btn.classList.toggle('active', btn.dataset.src === source));
  }

  // ---- döviz çevirici ----------------------------------------------------

  function rateMap() {
    const m = { TRY: 1 };
    FX.forEach((f) => {
      const q = quotes[f.sym];
      if (q && q.price) m[f.code] = q.price;
    });
    if (gram) m.XAU = gram;
    return m;
  }

  let convBuilt = false;
  function fillConverter() {
    if (convBuilt) return;                 // seçimi her yenilemede sıfırlama
    const codes = Object.keys(rateMap());
    const opt = (c) => `<option value="${c}">${c === 'XAU' ? t('fx.gramgold') : c}</option>`;
    el('conv-from').innerHTML = codes.map(opt).join('');
    el('conv-to').innerHTML = codes.map(opt).join('');
    el('conv-from').value = 'USD';
    el('conv-to').value = 'TRY';

    el('au-kind').innerHTML =
      GOLD.map((g) => `<option value="${g.key}">${t('gold.' + g.key)}</option>`).join('') +
      KARATS.map((k) => `<option value="${k.key}">${k.karat} ${t('fx.karat')} · 1 g</option>`).join('');
    convBuilt = true;
  }

  function convert() {
    const m = rateMap();
    const amt = parseFloat(el('conv-amt').value);
    const from = el('conv-from').value, to = el('conv-to').value;
    if (!isFinite(amt) || !m[from] || !m[to]) {
      el('conv-out').textContent = '—';
      el('conv-rate').textContent = '';
      return;
    }
    const out = (amt * m[from]) / m[to];
    const label = (c) => (c === 'XAU' ? t('fx.gramshort') : c);
    el('conv-out').textContent = `${UI.fmtNum(out, out < 10 ? 4 : 2)} ${label(to)}`;
    el('conv-rate').textContent =
      `1 ${label(from)} = ${UI.fmtNum(m[from] / m[to], 6)} ${label(to)}`;
  }

  // ---- altın hesaplayıcı -------------------------------------------------

  function calcGold() {
    const amt = parseFloat(el('au-amt').value);
    const kind = el('au-kind').value;
    if (!gram || !isFinite(amt)) {
      el('au-out').textContent = '—';
      el('au-detail').textContent = '';
      return;
    }
    const b = goldBasis();

    // Türk piyasası modunda ürünün kendi fiyatı varsa onu kullan; yoksa
    // (ve spot modunda) saf altın içeriğinden hesapla.
    const trItem = b && b.mode === 'tr' && G.turkish.items[kind];
    if (trItem && trItem.ask) {
      el('au-out').textContent = UI.fmtNum(trItem.ask * amt, 2) + ' ₺';
      el('au-detail').textContent = t('fx.detailTr', {
        n: UI.fmtNum(amt, amt % 1 === 0 ? 0 : 2),
        name: labelOf(kind),
        price: UI.fmtNum(trItem.ask, 2),
      });
      return;
    }

    let grams;
    const k = KARATS.find((x) => x.key === kind);
    if (k) grams = amt * k.fine;
    else grams = amt * pure(GOLD.find((x) => x.key === kind));

    el('au-out').textContent = UI.fmtNum(gram * grams, 2) + ' ₺';
    el('au-detail').textContent = t('fx.detail', {
      n: UI.fmtNum(grams, 4), name: labelOf(kind), price: UI.fmtNum(gram, 2),
    });
  }

  function labelOf(kind) {
    const k = KARATS.find((x) => x.key === kind);
    return k ? `${k.karat} ${t('fx.karat')}` : t('gold.' + kind);
  }

  // ---- künye tablosu -----------------------------------------------------

  function renderSpec() {
    el('spec-body').innerHTML = GOLD.map((g) => `<tr>
      <td>${t('gold.' + g.key)}</td>
      <td>${UI.fmtNum(g.gross, 4)} g</td>
      <td>${g.karat} ${t('fx.karat')}</td>
      <td>${UI.fmtNum(pure(g), 4)} g</td>
    </tr>`).join('');
  }

  // ---- grafik ------------------------------------------------------------

  async function history(sym) {
    if (histCache[sym]) return histCache[sym];
    const res = await API.history(sym, '1y');
    histCache[sym] = res.history || [];
    return histCache[sym];
  }

  // Gram altının geçmişi hiçbir kaynakta yok; ons ve dolar serilerini ORTAK
  // tarihler üzerinden eşleyip türetiyoruz. Geçmiş seri kaçınılmaz olarak
  // vadeli fiyattan gelir — seviye değil, EĞİLİM göstermek için kullanılıyor.
  async function gramHistory() {
    if (histCache.GRAM) return histCache.GRAM;
    const [ons, usd] = await Promise.all([history('GC=F'), history('USDTRY=X')]);
    const fx = new Map(usd.map((p) => [p.date, p.close]));
    histCache.GRAM = ons
      .filter((p) => fx.has(p.date))
      .map((p) => ({ date: p.date, close: (p.close * fx.get(p.date)) / ONS_GRAM }));
    return histCache.GRAM;
  }

  async function drawChart(series) {
    const canvas = el('fx-chart');
    try {
      const data = series === 'GRAM' ? await gramHistory() : await history(series);
      if (chart) { chart.destroy(); chart = null; }
      if (!data.length) return;
      chart = UI.priceChart(
        canvas,
        data.map((p) => p.date),
        data.map((p) => p.close),
        { color: series === 'GRAM' || series === 'GC=F' ? UI.COLORS.amber : UI.COLORS.cyan,
          currency: series === 'GC=F' ? '$' : '₺' },
      );
    } catch (err) {
      canvas.parentElement.innerHTML = `<div class="error-box">${UI.esc(err.message)}</div>`;
    }
  }

  // ---- olaylar -----------------------------------------------------------

  el('fx-src').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-src]');
    if (!btn || btn.dataset.src === source) return;
    source = btn.dataset.src;
    localStorage.setItem(SRC_KEY, source);
    renderGold();          // veri zaten elimizde, ağa çıkmaya gerek yok
    convert();
    calcGold();
  });

  ['conv-amt', 'conv-from', 'conv-to'].forEach((id) =>
    el(id).addEventListener('input', convert));
  el('conv-swap').addEventListener('click', () => {
    const a = el('conv-from').value;
    el('conv-from').value = el('conv-to').value;
    el('conv-to').value = a;
    convert();
  });
  ['au-amt', 'au-kind'].forEach((id) => el(id).addEventListener('input', calcGold));

  el('chart-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-series]');
    if (!btn || btn.classList.contains('active')) return;
    el('chart-tabs').querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    drawChart(btn.dataset.series);
  });

  renderSpec();
  load();
  drawChart('USDTRY=X');
  const timer = setInterval(load, REFRESH_MS);
  window.addEventListener('beforeunload', () => clearInterval(timer));
})();
