// Update notification: a version badge in the topbar (with an amber dot when
// there's an unseen release) that opens a bilingual changelog panel. The badge,
// panel and overlay are injected here so no page markup needs editing.
// "Seen" version is tracked in localStorage; a new release auto-opens once.
(function () {
  const CURRENT = '2.2';

  const CHANGELOG = [
    {
      v: '2.2', date: '2026-08-02',
      tr: ['F5 Piyasa Haritası — BIST hisseleri sektöre göre, günlük değişime göre renkli',
           'Sürüm notları bildirimi (bu panel) eklendi'],
      en: ['F5 Market Map — BIST stocks by sector, colored by daily change',
           'Release-notes notification (this panel) added'],
    },
    {
      v: '2.1', date: '2026-07-24',
      tr: ['F3 Karşılaştırma ve F4 Fon Tarayıcı sayfaları',
           'Ana sayfada Piyasa Gündemi + haberlere hisse rozetleri',
           'Borsa açık/kapalı göstergesi ve seçili aralık getirisi'],
      en: ['F3 Compare and F4 Fund Screener pages',
           'Market Headlines panel with ticker chips on the home page',
           'Market open/closed badge and selected-range return'],
    },
    {
      v: '2.0', date: '2026-07-23',
      tr: ['Python backend’e geçiş, Risk Motoru (VaR / CVaR / Monte Carlo)',
           'Opsiyon duyarlılıkları (Greeks), TEFAS fonları, haber duyarlılığı',
           'Türkçe/İngilizce dil desteği ve mobil uyumlu arayüz'],
      en: ['Python backend, Risk Engine (VaR / CVaR / Monte Carlo)',
           'Option Greeks, TEFAS funds, news sentiment',
           'Bilingual TR/EN and mobile-friendly interface'],
    },
  ];

  function t(key) {
    return typeof I18N !== 'undefined' ? I18N.t(key) : key;
  }
  const lang = () => (typeof I18N !== 'undefined' ? I18N.lang : 'tr');

  function build() {
    const topsearch = document.querySelector('.topsearch');
    if (!topsearch) return;
    const seen = localStorage.getItem('finansla_seen_version');
    const unseen = seen !== CURRENT;

    // Version badge button
    const btn = document.createElement('button');
    btn.className = 'btn ver-btn';
    btn.id = 'ver-btn';
    btn.innerHTML = `v${CURRENT} <span class="ver-dot" ${unseen ? '' : 'hidden'}></span>`;
    btn.title = t('wn.title');
    const langBtn = document.getElementById('lang-toggle');
    topsearch.insertBefore(btn, langBtn || null);

    // Overlay + panel
    const overlay = document.createElement('div');
    overlay.className = 'wn-overlay';
    overlay.id = 'wn-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="wn-panel" role="dialog" aria-modal="true">
        <div class="wn-head"><span>${t('wn.title')}</span><span class="wn-x" id="wn-x">✕</span></div>
        <div class="wn-body" id="wn-body"></div>
        <div class="wn-foot"><button class="btn primary" id="wn-ok">${t('wn.close')}</button></div>
      </div>`;
    document.body.appendChild(overlay);

    function renderBody() {
      const L = lang();
      document.getElementById('wn-body').innerHTML = CHANGELOG.map((rel, i) => `
        <div class="wn-rel">
          <div class="wn-ver">v${rel.v} ${i === 0 ? `<span class="wn-new">${t('wn.new')}</span>` : ''}
            <span class="wn-date">${rel.date}</span></div>
          <ul>${rel[L].map((line) => `<li>${line}</li>`).join('')}</ul>
        </div>`).join('');
    }

    function open() {
      renderBody();
      overlay.hidden = false;
      localStorage.setItem('finansla_seen_version', CURRENT);
      const dot = btn.querySelector('.ver-dot');
      if (dot) dot.hidden = true;
    }
    function close() { overlay.hidden = true; }

    btn.addEventListener('click', open);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('wn-x').addEventListener('click', close);
    document.getElementById('wn-ok').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    // No auto-open: the blinking badge invites a click; the panel only opens
    // when the user actually clicks it. The dot clears once they've opened it.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
