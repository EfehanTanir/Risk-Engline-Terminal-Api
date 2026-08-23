// Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
// SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

// İZLEME LİSTESİ
// Terminalin kullanıcıyı hatırladığı ilk yer. Hisse ve fon sayfalarındaki
// yıldız butonu buraya yazar, ana sayfadaki panel buradan okur.
//
// Tamamen TARAYICIDA durur (localStorage): hesap yok, sunucuya hiçbir şey
// gitmiyor, KVKK açısından da saklanan kişisel veri yok. Bedeli, listenin
// cihaza bağlı olması — başka bilgisayarda görünmez. Bilinçli tercih:
// hesap sistemi kurmak bu aşamada maliyeti faydasından büyük.
const WL = (() => {
  const KEY = 'finansla_watchlist';
  const MAX = 30;

  function list() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      // Dış dünyadan gelen veri gibi davran: bozuk kayıt tüm paneli çökertmesin.
      return Array.isArray(raw)
        ? raw.filter((x) => x && typeof x.id === 'string' && x.id).slice(0, MAX)
        : [];
    } catch {
      return [];
    }
  }

  function save(items) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX)));
    } catch { /* kota dolu veya gizli mod — sessizce vazgeç */ }
  }

  const has = (id) => list().some((x) => x.id === id);

  function toggle(item) {
    const items = list();
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) items.splice(i, 1);
    else items.unshift({ type: item.type, id: item.id, name: item.name || item.id });
    save(items);
    return i < 0;            // true = eklendi
  }

  function remove(id) {
    save(list().filter((x) => x.id !== id));
  }

  const t = (k) => (typeof I18N !== 'undefined' ? I18N.t(k) : k);

  // ---- hisse / fon sayfasındaki yıldız --------------------------------

  /** Sayfa verisi yüklendikten sonra çağrılır: yıldızı gösterir ve bağlar. */
  function initStar(item) {
    const btn = document.getElementById('wl-star');
    if (!btn || !item || !item.id) return;

    const paint = () => {
      const on = has(item.id);
      btn.textContent = on ? '★' : '☆';
      btn.classList.toggle('on', on);
      btn.title = on ? t('wl.remove') : t('wl.add');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };

    btn.hidden = false;
    paint();
    btn.addEventListener('click', () => {
      toggle(item);
      paint();
    });
  }

  // ---- ana sayfadaki panel --------------------------------------------

  /** Kartın ana rakamı türe göre DEĞİŞİR:
   *   hisse → son fiyat + günlük değişim
   *   fon   → 1 aylık getiri (TEFAS'ta anlık fiyat yok, NAV günde bir açıklanır)
   *  Fon kartında fiyat göstermeye çalışmak yanıltıcı olurdu; onun yerine
   *  fonun gerçekten takip edilebilir tek sayısını gösteriyoruz. */
  function card(item, data) {
    if (item.type === 'fund') {
      const r = data && data.returns ? data.returns['1m'] : null;
      const ok = typeof r === 'number' && isFinite(r);
      return shell(item,
        ok ? `<span class="${UI.chgClass(r)}">${UI.fmtPctRaw(r, 2)}</span>` : '—',
        `${t('wl.fund1m')} · ${UI.esc((item.name || '').slice(0, 22))}`);
    }
    const px = data && typeof data.price === 'number'
      ? UI.fmtNum(data.price, data.price < 10 ? 4 : 2) : '—';
    const chg = data && typeof data.changePercent === 'number'
      ? `<span class="${UI.chgClass(data.changePercent)}">${UI.fmtPctRaw(data.changePercent, 2)}</span>`
      : '<span class="faint">—</span>';
    return shell(item, px, `${chg} · ${UI.esc((item.name || '').slice(0, 26))}`);
  }

  function shell(item, value, sub) {
    const href = item.type === 'fund'
      ? `fund.html?code=${encodeURIComponent(item.id)}`
      : `stock.html?symbol=${encodeURIComponent(item.id)}`;
    return `<div class="tile wl-tile">
      <button class="wl-x" data-wl-x="${UI.esc(item.id)}" title="${t('wl.remove')}" aria-label="${t('wl.remove')}">✕</button>
      <a class="wl-link" href="${href}">
        <div class="k">${UI.esc(item.id)}</div>
        <div class="v">${value}</div>
        <div class="s">${sub}</div>
      </a>
    </div>`;
  }

  async function renderPanel() {
    const box = document.getElementById('wl-cards');
    const section = document.getElementById('wl-section');
    if (!box || !section) return;

    const items = list();
    if (!items.length) { section.hidden = true; return; }
    section.hidden = false;
    document.getElementById('wl-count').textContent = `${items.length} ${t('wl.items')}`;

    // Önce verisiz çiz — panel anında görünsün, ağ beklenmesin.
    box.innerHTML = items.map((i) => card(i, null)).join('');
    wireRemove();

    const symbols = items.filter((i) => i.type !== 'fund').map((i) => i.id);
    const hasFund = items.some((i) => i.type === 'fund');
    const data = {};

    // İki kaynak paralel; biri düşerse diğeri yine dolar.
    // Fon evreni sunucuda önbellekli ve tek çağrı bütün fonları kapsıyor,
    // bu yüzden fon başına ayrı istek atmıyoruz.
    await Promise.all([
      symbols.length ? API.quotes(symbols.slice(0, 15))
        .then((r) => (r.quotes || []).forEach((q) => { data[q.symbol] = q; }))
        .catch(() => {}) : null,
      hasFund ? API.funds()
        .then((r) => (r.funds || []).forEach((f) => { data[f.code] = f; }))
        .catch(() => {}) : null,
    ]);

    box.innerHTML = items.map((i) => card(i, data[i.id])).join('');
    wireRemove();
  }

  function wireRemove() {
    document.querySelectorAll('[data-wl-x]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        remove(el.dataset.wlX);
        renderPanel();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderPanel);
  } else {
    renderPanel();
  }

  return { list, has, toggle, remove, initStar, renderPanel };
})();
