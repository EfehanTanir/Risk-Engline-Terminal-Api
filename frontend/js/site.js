// Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
// SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

// Site geneli kontrol: yönetim panelinden yazılan duyuru bandı ve bakım modu.
//
// Her sayfada çalışır, /api/site-config ucunu okur ve sonucu uygular. API
// yanıt vermezse hiçbir şey göstermez — bir arıza, siteyi yanlışlıkla bakım
// ekranına kilitleyemez.
//
// Not: bakım ekranı bir GÜVENLİK sınırı değil, nezaket bildirimidir. Tarayıcı
// konsolunu bilen biri her hâlükârda geçebilir; API'ler çalışmaya devam eder.
// Amaç erişimi engellemek değil, ziyaretçiyi durumdan haberdar etmek.
(function () {
  const POLL_MS = 60000;
  const DISMISS_KEY = 'finansla_banner_seen';
  const BYPASS_KEY = 'finansla_admin_bypass';

  const lang = () => (typeof I18N !== 'undefined' && I18N.lang) ? I18N.lang : 'tr';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  let bannerEl = null;
  let maintEl = null;

  function pick(obj) {
    if (!obj) return '';
    return (lang() === 'en' ? obj.en : obj.tr) || obj.tr || obj.en || '';
  }

  // ---- duyuru bandı ------------------------------------------------------

  function renderBanner(cfg) {
    const b = cfg.banner || {};
    const text = pick(b);
    const stamp = String(cfg.updatedAt || 0);

    // Kapatılmışsa gizle — ama YENİ bir duyuru (farklı updatedAt) yine görünsün
    const dismissed = sessionStorage.getItem(DISMISS_KEY) === stamp;

    if (!b.active || !text || dismissed) {
      if (bannerEl) { bannerEl.remove(); bannerEl = null; }
      return;
    }

    if (!bannerEl) {
      bannerEl = document.createElement('div');
      bannerEl.className = 'site-banner';
      document.body.insertBefore(bannerEl, document.body.firstChild);
    }
    bannerEl.className = `site-banner ${b.level || 'info'}`;
    bannerEl.innerHTML =
      `<span class="sb-dot"></span><span class="sb-text">${esc(text)}</span>` +
      `<button class="sb-x" aria-label="Kapat">✕</button>`;
    bannerEl.querySelector('.sb-x').addEventListener('click', () => {
      sessionStorage.setItem(DISMISS_KEY, stamp);
      bannerEl.remove();
      bannerEl = null;
    });
  }

  // ---- bakım modu --------------------------------------------------------

  function renderMaintenance(cfg) {
    const m = cfg.maintenance || {};
    const bypass = localStorage.getItem(BYPASS_KEY) === '1';

    if (!m.active || bypass) {
      if (maintEl) { maintEl.remove(); maintEl = null; document.body.style.overflow = ''; }
      return;
    }
    if (maintEl) return;   // zaten ekranda

    const text = pick(m) || (lang() === 'en'
      ? 'The terminal is temporarily under maintenance. Please try again shortly.'
      : 'Terminal geçici olarak bakımda. Kısa süre sonra tekrar deneyin.');
    const title = lang() === 'en' ? 'MAINTENANCE' : 'BAKIM ÇALIŞMASI';

    maintEl = document.createElement('div');
    maintEl.className = 'site-maint';
    maintEl.innerHTML = `
      <div class="site-maint-box">
        <div class="sm-brand">FINANSLA<span>TERMINAL</span></div>
        <div class="sm-title">${title}</div>
        <div class="sm-text">${esc(text)}</div>
        <div class="sm-foot">terminal.finansla.net</div>
      </div>`;
    document.body.appendChild(maintEl);
    document.body.style.overflow = 'hidden';
  }

  // ---- yükleme -----------------------------------------------------------

  async function refresh() {
    const base = window.FINANSLA && window.FINANSLA.API_BASE;
    if (!base) return;
    try {
      const res = await fetch(`${base}/site-config`);
      if (!res.ok) return;
      const cfg = await res.json();
      renderBanner(cfg);
      renderMaintenance(cfg);
    } catch {
      // Sessizce geç: ayar okunamadığında site normal çalışmalı
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
})();
