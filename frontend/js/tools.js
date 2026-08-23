// Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
// SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

// Yönetim paneli araçları: paylaşım kartı üreticisi ve sembol test aracı.
//
// İkisi de yalnızca projenin KENDİ API'sini kullanır — dışarıya, herhangi bir
// yapay zeka servisine veya üçüncü tarafa tek bir istek gitmez. Kart tamamen
// tarayıcıda <canvas> üzerine çizilir, yani üretimi bedava ve anlıktır.
(function () {
  const C = {
    bg: '#070b10', panel: '#0d141c', border: '#1c2936',
    ink: '#d7e0e7', muted: '#7e8fa0', faint: '#4d5c6b',
    amber: '#ffb000', up: '#2fd07e', down: '#ff5252', cyan: '#38bdf8',
  };
  const FONT = '"JetBrains Mono", monospace';
  const SIZES = { wide: [1200, 630], square: [1080, 1080] };
  const CCY = { TRY: '₺', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

  const $ = (id) => document.getElementById(id);
  const api = () => (window.FINANSLA && window.FINANSLA.API_BASE) || '';

  const num = (v, d = 2) =>
    v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('tr-TR',
      { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, d = 1) => (v == null || !isFinite(v) ? '—' : `%${num(v * 100, d)}`);

  // ======================================================================
  //  1. PAYLAŞIM KARTI
  // ======================================================================

  let card = null;   // {code, name, price, changePct, ccy, series, metrics, tag}

  // ---- arama / otomatik tamamlama --------------------------------------
  // Ana sayfadaki aramanın aynısı: kodları ezberlemek yerine adıyla bulun.

  let hits = [];     // açık listedeki sonuçlar, Enter ilkini seçsin diye

  function hideDrop() {
    $('card-drop').hidden = true;
    hits = [];
  }

  function renderDrop(stocks, funds) {
    hits = [
      ...stocks.slice(0, 6).map((s) => ({
        kind: 'stock', id: s.symbol, code: s.symbol.replace('.IS', ''),
        name: s.name, meta: s.exchange || s.type || '',
      })),
      ...funds.slice(0, 6).map((f) => ({
        kind: 'fund', id: f.code, code: f.code,
        name: f.title, meta: 'TEFAS',
      })),
    ];
    const drop = $('card-drop');
    if (!hits.length) {
      drop.innerHTML = '<div class="tool-drop-empty">sonuç yok</div>';
      drop.hidden = false;
      return;
    }
    drop.innerHTML = hits.map((h, i) => `
      <div class="tool-drop-row" data-i="${i}">
        <span class="c">${UI.esc(h.code)}</span>
        <span class="n">${UI.esc(h.name || '')}</span>
        <span class="m">${UI.esc(h.meta)}</span>
      </div>`).join('');
    drop.hidden = false;
  }

  function pick(hit) {
    if (!hit) return;
    $('card-kind').value = hit.kind;
    $('card-symbol').value = hit.id;
    hideDrop();
    fetchCard();
  }

  async function search(q) {
    if (!q || q.trim().length < 2) return hideDrop();
    try {
      const r = await fetch(`${api()}/search?q=${encodeURIComponent(q.trim())}`);
      if (!r.ok) return hideDrop();
      const d = await r.json();
      renderDrop(d.stocks || [], d.funds || []);
    } catch {
      hideDrop();
    }
  }

  async function fetchCard() {
    const kind = $('card-kind').value;
    const raw = $('card-symbol').value.trim();
    if (!raw) return;

    $('card-status').textContent = 'veri çekiliyor…';
    $('card-download').disabled = true;
    try {
      let d;
      if (kind === 'fund') {
        const r = await fetch(`${api()}/fund?code=${encodeURIComponent(raw)}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `Fon bulunamadı (${r.status})`);
        d = await r.json();
        const hist = d.history || [];
        const prev = hist.length > 1 ? hist[hist.length - 2].close : null;
        const last = d.latest.price;
        card = {
          code: d.profile.code,
          name: d.profile.title,
          price: last,
          changePct: prev ? ((last - prev) / prev) * 100 : null,
          ccy: 'TRY',
          tag: d.profile.category || 'TEFAS FONU',
          series: hist.map((h) => h.close),
          metrics: d.risk,
        };
      } else {
        const r = await fetch(`${api()}/stock?symbol=${encodeURIComponent(raw)}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `Sembol bulunamadı (${r.status})`);
        d = await r.json();
        card = {
          code: (d.profile.symbol || raw).replace('.IS', ''),
          name: d.profile.longName || d.profile.shortName || raw,
          price: d.quote.price,
          changePct: d.quote.changePercent,
          ccy: d.profile.currency || 'USD',
          tag: d.profile.isTurkish ? 'BIST' : (d.profile.exchange || ''),
          series: (d.history || []).map((h) => h.close),
          metrics: d.risk,
        };
      }
      $('card-status').textContent = '';
      drawCard();
      $('card-download').disabled = false;
    } catch (e) {
      card = null;
      $('card-status').innerHTML = `<span class="down">${e.message}</span>`;
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawSparkline(ctx, series, x, y, w, h, color) {
    const pts = series.slice(-160).filter((v) => isFinite(v));
    if (pts.length < 2) return;
    const lo = Math.min(...pts), hi = Math.max(...pts);
    const span = hi - lo || 1;
    const px = (i) => x + (i / (pts.length - 1)) * w;
    const py = (v) => y + h - ((v - lo) / span) * h;

    // dolgu
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, `${color}44`);
    grad.addColorStop(1, `${color}00`);
    ctx.beginPath();
    ctx.moveTo(px(0), py(pts[0]));
    pts.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.lineTo(px(pts.length - 1), y + h);
    ctx.lineTo(px(0), y + h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // çizgi
    ctx.beginPath();
    ctx.moveTo(px(0), py(pts[0]));
    pts.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function drawCard() {
    if (!card) return;
    const [W, H] = SIZES[$('card-size').value] || SIZES.wide;
    const cv = $('card-canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const sq = H > W * 0.8;                   // kare düzen mi
    const pad = Math.round(W * 0.062);
    const up = (card.changePct || 0) >= 0;
    const accent = card.changePct == null ? C.muted : (up ? C.up : C.down);
    const sym = CCY[card.ccy] || '';

    // zemin
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, W, Math.round(H * 0.13));
    ctx.fillStyle = C.border;
    ctx.fillRect(0, Math.round(H * 0.13), W, 2);

    // üst şerit: marka + etiket
    const hy = Math.round(H * 0.078);
    ctx.fillStyle = C.amber;
    ctx.fillRect(pad, hy - 26, 12, 32);
    ctx.font = `700 ${Math.round(W * 0.026)}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('FINANSLA', pad + 28, hy);
    const bw = ctx.measureText('FINANSLA').width;
    ctx.fillStyle = C.ink;
    ctx.font = `400 ${Math.round(W * 0.026)}px ${FONT}`;
    ctx.fillText('TERMINAL', pad + 40 + bw, hy);

    if (card.tag) {
      ctx.font = `700 ${Math.round(W * 0.0155)}px ${FONT}`;
      ctx.textAlign = 'right';
      const tw = ctx.measureText(card.tag.toUpperCase()).width;
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 2;
      roundRect(ctx, W - pad - tw - 24, hy - 24, tw + 24, 34, 4);
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.fillText(card.tag.toUpperCase(), W - pad - 12, hy);
    }

    // kod + isim
    let y = Math.round(H * (sq ? 0.26 : 0.32));
    ctx.textAlign = 'left';
    ctx.fillStyle = C.amber;
    ctx.font = `700 ${Math.round(W * 0.072)}px ${FONT}`;
    ctx.fillText(card.code, pad, y);

    ctx.fillStyle = C.muted;
    ctx.font = `400 ${Math.round(W * 0.0195)}px ${FONT}`;
    let name = card.name || '';
    const maxName = W - pad * 2;
    while (name && ctx.measureText(name).width > maxName) name = name.slice(0, -2);
    if (name !== card.name) name = name.replace(/.$/, '…');
    ctx.fillText(name, pad, y + Math.round(H * 0.048));

    // fiyat + değişim (sağ üstte, kare düzende alta iner)
    ctx.textAlign = sq ? 'left' : 'right';
    const px0 = sq ? pad : W - pad;
    const py0 = sq ? y + Math.round(H * 0.14) : y;
    ctx.fillStyle = C.ink;
    ctx.font = `700 ${Math.round(W * 0.058)}px ${FONT}`;
    ctx.fillText(`${sym}${num(card.price, card.price < 10 ? 4 : 2)}`, px0, py0);

    if (card.changePct != null) {
      ctx.fillStyle = accent;
      ctx.font = `700 ${Math.round(W * 0.028)}px ${FONT}`;
      const arrow = up ? '▲' : '▼';
      ctx.fillText(`${arrow} %${num(Math.abs(card.changePct), 2)}`,
        px0, py0 + Math.round(H * 0.055));
    }

    // grafik
    const gy = Math.round(H * (sq ? 0.52 : 0.50));
    const gh = Math.round(H * (sq ? 0.18 : 0.20));
    drawSparkline(ctx, card.series, pad, gy, W - pad * 2, gh, accent);

    // metrik şeridi
    const m = card.metrics || {};
    const cells = [
      ['VOLATİLİTE', pct(m.annVolatility, 1)],
      ['SHARPE', num(m.sharpe, 2)],
      ['MAX DÜŞÜŞ', m.maxDrawdown == null ? '—' : `-${pct(Math.abs(m.maxDrawdown), 1).slice(1)}`],
      ['VaR %95', m.var95Hist == null ? '—' : `-${pct(Math.abs(m.var95Hist), 2).slice(1)}`],
    ];
    const my = gy + gh + Math.round(H * (sq ? 0.10 : 0.115));
    const cw = (W - pad * 2) / cells.length;
    ctx.textAlign = 'left';
    cells.forEach(([k, v], i) => {
      const cx = pad + cw * i;
      if (i > 0) {
        ctx.fillStyle = C.border;
        ctx.fillRect(cx - 1, my - Math.round(H * 0.045), 2, Math.round(H * 0.062));
      }
      ctx.fillStyle = C.faint;
      ctx.font = `400 ${Math.round(W * 0.0135)}px ${FONT}`;
      ctx.fillText(k, cx + 14, my - Math.round(H * 0.022));
      ctx.fillStyle = C.ink;
      ctx.font = `700 ${Math.round(W * 0.026)}px ${FONT}`;
      ctx.fillText(v, cx + 14, my + Math.round(H * 0.014));
    });

    // alt şerit
    const fy = H - Math.round(H * 0.052);
    ctx.fillStyle = C.border;
    ctx.fillRect(0, H - Math.round(H * 0.105), W, 2);
    ctx.fillStyle = C.amber;
    ctx.font = `700 ${Math.round(W * 0.0165)}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('terminal.finansla.net', pad, fy);
    ctx.fillStyle = C.faint;
    ctx.font = `400 ${Math.round(W * 0.0125)}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText('Eğitim amaçlıdır · Yatırım tavsiyesi değildir', W - pad, fy);
  }

  function downloadCard() {
    if (!card) return;
    const a = document.createElement('a');
    a.download = `finansla-${card.code}-${new Date().toISOString().slice(0, 10)}.png`;
    a.href = $('card-canvas').toDataURL('image/png');
    a.click();
  }

  // ======================================================================
  //  2. SEMBOL TEST ARACI
  // ======================================================================

  const CHUNK = 15;   // /api/quotes tek seferde en fazla 15 sembol alıyor

  async function runTest() {
    const raw = $('test-input').value;
    const symbols = [...new Set(raw.split(/[\s,;\n]+/)
      .map((s) => s.trim().toUpperCase()).filter(Boolean))];

    if (!symbols.length) return;
    if (symbols.length > 200) {
      $('test-summary').innerHTML = '<span class="down">En fazla 200 sembol.</span>';
      return;
    }

    const btn = $('test-run');
    btn.disabled = true;
    const found = new Map();
    let done = 0;

    for (let i = 0; i < symbols.length; i += CHUNK) {
      const batch = symbols.slice(i, i + CHUNK);
      $('test-summary').textContent = `test ediliyor… ${done}/${symbols.length}`;
      try {
        const r = await fetch(`${api()}/quotes?symbols=${encodeURIComponent(batch.join(','))}`);
        if (r.ok) {
          const { quotes } = await r.json();
          (quotes || []).forEach((q) => found.set(q.symbol.toUpperCase(), q));
        }
      } catch { /* bu partiyi başarısız say, devam et */ }
      done += batch.length;
    }

    const ok = symbols.filter((s) => found.has(s));
    const bad = symbols.filter((s) => !found.has(s));

    $('test-summary').innerHTML =
      `<span class="up">${ok.length} çalışıyor</span> · ` +
      `<span class="${bad.length ? 'down' : 'faint'}">${bad.length} başarısız</span> · ` +
      `<span class="faint">${symbols.length} sembol</span>`;

    $('test-results').innerHTML = symbols.map((s) => {
      const q = found.get(s);
      if (!q) {
        return `<div class="tt-row bad"><span class="s">${UI.esc(s)}</span>
          <span class="n faint">çözülemedi</span><span class="p">—</span>
          <span class="st">HATA</span></div>`;
      }
      const cls = q.changePercent > 0 ? 'up' : q.changePercent < 0 ? 'down' : 'neu';
      return `<div class="tt-row"><span class="s">${UI.esc(s)}</span>
        <span class="n">${UI.esc(q.name || '')}</span>
        <span class="p mono-num">${num(q.price, q.price < 10 ? 4 : 2)}</span>
        <span class="st ${cls} mono-num">${q.changePercent == null ? '—' : num(q.changePercent, 2) + '%'}</span></div>`;
    }).join('');

    $('test-copy-ok').dataset.list = ok.join(', ');
    $('test-copy-bad').dataset.list = bad.join(', ');
    $('test-copy-ok').disabled = !ok.length;
    $('test-copy-bad').disabled = !bad.length;
    btn.disabled = false;
  }

  function copyList(btn) {
    const list = btn.dataset.list || '';
    navigator.clipboard.writeText(list).then(() => {
      const old = btn.textContent;
      btn.textContent = 'KOPYALANDI';
      setTimeout(() => { btn.textContent = old; }, 1200);
    });
  }

  // ======================================================================

  function init() {
    const input = $('card-symbol');
    const drop = $('card-drop');
    const debounced = UI.debounce(search, 300);

    input.addEventListener('input', () => debounced(input.value));
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) debounced(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return hideDrop();
      if (e.key !== 'Enter') return;
      // Liste açıksa ilk sonucu seç, değilse yazılanı olduğu gibi dene
      if (!drop.hidden && hits.length) pick(hits[0]);
      else { hideDrop(); fetchCard(); }
    });

    drop.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.tool-drop-row');
      if (row) { e.preventDefault(); pick(hits[Number(row.dataset.i)]); }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tool-search')) hideDrop();
    });

    $('card-load').addEventListener('click', () => { hideDrop(); fetchCard(); });
    $('card-size').addEventListener('change', drawCard);
    $('card-download').addEventListener('click', downloadCard);

    $('test-run').addEventListener('click', runTest);
    $('test-copy-ok').addEventListener('click', (e) => copyList(e.target));
    $('test-copy-bad').addEventListener('click', (e) => copyList(e.target));

    // Canvas yazı tipini kullanmadan önce fontun yüklenmesini bekle, yoksa
    // ilk kart varsayılan sistem fontuyla çizilir.
    if (document.fonts && document.fonts.load) {
      document.fonts.load(`700 64px ${FONT}`).catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
