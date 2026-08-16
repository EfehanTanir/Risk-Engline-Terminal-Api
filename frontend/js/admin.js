// Admin panosu: servis sağlığı, canlı ziyaretçiler ve kullanım analitiği.
//
// Giriş: kullanıcı adı ve şifre yok. Authenticator uygulamasındaki 6 haneli
// TOTP kodu sunucuya gönderilir, karşılığında 8 saatlik imzalı bir oturum
// jetonu alınır. Jeton sessionStorage'da tutulur (yalnızca bu sekme, sekme
// kapanınca silinir) ve X-Admin-Session başlığıyla yollanır — asla URL'ye
// konmaz, çünkü sorgu dizeleri sunucu günlüklerine ve tarayıcı geçmişine düşer.
(function () {
  const KEY = 'finansla_admin_session';
  const STATS_MS = 10000;   // canlıya yakın yenileme
  const HEALTH_MS = 60000;  // sağlık sondaları yavaş, seyrek yoklanır

  const $ = (id) => document.getElementById(id);
  const gate = $('gate');
  const dash = $('dash');

  let session = sessionStorage.getItem(KEY) || '';
  let days = 7;
  let auto = true;
  let statsTimer = null;
  let healthTimer = null;

  $('api-target').textContent = (window.FINANSLA && window.FINANSLA.API_BASE) || '';

  // ---- api ---------------------------------------------------------------

  async function call(path, opts) {
    const res = await fetch(`${window.FINANSLA.API_BASE}${path}`, Object.assign({
      headers: { 'X-Admin-Session': session, 'Content-Type': 'application/json' },
    }, opts || {}));
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      forceLogout();
      throw new Error(body.detail || 'Oturum sona erdi');
    }
    if (!res.ok) throw new Error(body.detail || body.error || `API hatası ${res.status}`);
    return body;
  }

  function forceLogout() {
    sessionStorage.removeItem(KEY);
    session = '';
    stopTimers();
    dash.hidden = true;
    gate.hidden = false;
    $('logout-btn').hidden = true;
    $('code-input').value = '';
  }

  // ---- giriş -------------------------------------------------------------

  function enter() {
    gate.hidden = true;
    dash.hidden = false;
    $('logout-btn').hidden = false;
    refreshAll();
    startTimers();
  }

  async function login(code) {
    const err = $('gate-error');
    err.hidden = true;
    $('login-btn').disabled = true;
    try {
      const res = await fetch(`${window.FINANSLA.API_BASE}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || `Giriş başarısız (${res.status})`);
      session = body.token;
      sessionStorage.setItem(KEY, session);
      enter();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      $('code-input').value = '';
      $('code-input').focus();
    } finally {
      $('login-btn').disabled = false;
    }
  }

  const codeInput = $('code-input');

  // Sadece rakam kabul et; 6 haneye ulaşınca kendiliğinden gönder — kodun
  // ömrü 30 saniye, fazladan bir tıkla vakit kaybetmenin anlamı yok.
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (codeInput.value.length === 6) login(codeInput.value);
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && codeInput.value.length === 6) login(codeInput.value);
  });

  $('login-btn').addEventListener('click', () => {
    if (codeInput.value.length === 6) login(codeInput.value);
  });

  $('logout-btn').addEventListener('click', forceLogout);

  // Authenticator kodunun ne zaman yenileneceğini göster (30 sn'lik periyot).
  setInterval(() => {
    if (gate.hidden) return;
    const left = 30 - (Math.floor(Date.now() / 1000) % 30);
    $('totp-countdown').textContent = `KOD YENİLENİYOR: ${left}sn`;
  }, 1000);

  // ---- yardımcılar -------------------------------------------------------

  const n = (v) => (v == null ? '—' : Number(v).toLocaleString('tr-TR'));

  function ago(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return `${s}sn`;
    if (s < 3600) return `${Math.floor(s / 60)}dk`;
    if (s < 86400) return `${Math.floor(s / 3600)}sa`;
    return `${Math.floor(s / 86400)}g`;
  }

  function board(elId, rows, { accent = 'amber', empty = 'VERİ YOK' } = {}) {
    const el = $(elId);
    if (!rows || !rows.length) {
      el.innerHTML = `<div class="loading" style="color:var(--faint);padding:18px">${empty}</div>`;
      return;
    }
    const max = Math.max(...rows.map((r) => r.count)) || 1;
    el.innerHTML = rows.map((r) => `
      <div class="admin-row">
        <span class="admin-row-bar" style="width:${(r.count / max) * 100}%;background:var(--${accent})"></span>
        <span class="k">${UI.esc(r.name)}</span>
        <span class="v mono-num">${n(r.count)}</span>
      </div>`).join('');
  }

  function renderKpis(t) {
    const tiles = [
      { k: 'ŞU AN ÇEVRİMİÇİ', v: n(t.onlineNow), s: 'son 5 dakika', cls: t.onlineNow > 0 ? 'up' : 'faint' },
      { k: 'BUGÜN GÖRÜNTÜLEME', v: n(t.todayViews), s: '00:00 IST itibarıyla' },
      { k: 'BUGÜN ZİYARETÇİ', v: n(t.todayVisitors), s: 'tekil' },
      { k: `${days} GÜN GÖRÜNTÜLEME`, v: n(t.periodViews), s: `son ${days} gün` },
      { k: `${days} GÜN ZİYARETÇİ`, v: n(t.periodVisitors), s: 'tekil, yaklaşık' },
      { k: 'TOPLAM GÖRÜNTÜLEME', v: n(t.allTimeViews), s: 'takip başlangıcından beri' },
    ];
    $('kpis').innerHTML = tiles.map((x) => `
      <div class="tile">
        <div class="k">${x.k}</div>
        <div class="v ${x.cls || ''}">${x.v}</div>
        <div class="s">${x.s}</div>
      </div>`).join('');
  }

  function renderBars(series) {
    const max = Math.max(...series.map((p) => p.views), 1);
    const box = $('traffic-bars');
    box.dataset.dense = series.length > 14 ? '1' : '0';
    box.innerHTML = series.map((p) => {
      const pct = (p.views / max) * 100;
      return `<div class="admin-bar" title="${p.date} — ${p.views} görüntüleme">
        <div class="admin-bar-fill" style="height:${Math.max(pct, p.views ? 2 : 0)}%"></div>
        <span class="admin-bar-label">${p.date.slice(5)}</span>
      </div>`;
    }).join('');
  }

  function renderFeed(events) {
    const el = $('live-feed');
    if (!events || !events.length) {
      el.innerHTML = '<div class="loading" style="color:var(--faint)">HENÜZ OLAY YOK</div>';
      return;
    }
    el.innerHTML = events.map((e) => {
      const where = [e.y, e.c].filter(Boolean).join(', ') || 'bilinmiyor';
      const detail = e.q ? `arama “${UI.esc(e.q)}”`
        : e.s ? UI.esc(e.s)
        : e.f ? `fon ${UI.esc(e.f)}` : '';
      return `<div class="admin-feed-row">
        <span class="t mono-num">${ago(e.t)}</span>
        <span class="p">${UI.esc(e.p || '')}</span>
        <span class="d">${detail}</span>
        <span class="w">${UI.esc(where)}</span>
        <span class="id faint">${UI.esc((e.v || '').slice(0, 6))}</span>
      </div>`;
    }).join('');
  }

  function renderHealth(h) {
    const order = ['yahoo', 'tefas', 'news', 'storage'];
    const names = {
      yahoo: 'YAHOO FINANCE', tefas: 'TEFAS', news: 'GOOGLE NEWS', storage: 'UPSTASH REDIS',
    };
    $('health-list').innerHTML = order.map((key) => {
      const s = h.services[key] || {};
      const ms = s.ms == null ? '—' : `${s.ms} ms`;
      const slow = s.ok && s.ms > 3000 ? ' slow' : '';
      return `<div class="admin-health ${s.ok ? 'ok' : 'bad'}">
        <span class="dot"></span>
        <span class="svc">${names[key]}</span>
        <span class="ms mono-num${slow}">${ms}</span>
        <span class="st">${s.ok ? 'OK' : 'HATA'}</span>
        ${s.detail ? `<div class="detail">${UI.esc(s.detail)}</div>` : ''}
      </div>`;
    }).join('');

    const i = h.instance, c = h.caches, cfg = h.config;
    const rows = [
      ['Bölge', `${i.region} · ${i.env}`],
      ['Örnek çalışma süresi', `${Math.floor(i.uptimeSec / 60)}dk ${Math.round(i.uptimeSec % 60)}sn`],
      ['Bu örneğin istekleri', n(i.requestsServed)],
      ['Dağıtılan commit', i.commit || '—'],
      ['Geçmiş önbelleği', `${n(c.history)} kayıt`],
      ['Isı haritası önbelleği', c.heatmap.length ? c.heatmap.join(', ') : 'boş'],
      ['Fon evreni önbelleği', c.fundUniverse
        ? `${n(c.fundUniverse)} fon · ${Math.floor((c.fundUniverseAgeSec || 0) / 60)}dk`
        : 'soğuk'],
      ['Analitik deposu', cfg.analyticsEnabled ? 'bağlı' : 'YAPILANDIRILMAMIŞ'],
      ['Giriş hız sınırı', cfg.loginRateLimited ? 'etkin' : 'KAPALI — Upstash gerekli'],
      ['RF vekilleri', `TRY %${(cfg.RF_TRY * 100).toFixed(1)} · USD %${(cfg.RF_USD * 100).toFixed(1)}`],
      ['Monte Carlo senaryo', n(cfg.MC_SIMS)],
    ];
    $('instance-list').innerHTML = rows.map(([k, v]) => `
      <div class="row"><span class="k">${k}</span><span class="v">${UI.esc(String(v))}</span></div>`).join('');
  }

  // ---- yükleyiciler ------------------------------------------------------

  async function loadStats() {
    try {
      const s = await call(`/admin/stats?days=${days}`);
      if (!s.enabled) {
        $('kpis').innerHTML = `<div class="error-box" style="grid-column:1/-1">
          Analitik deposu yapılandırılmamış. Vercel projesine
          UPSTASH_REDIS_REST_URL ve UPSTASH_REDIS_REST_TOKEN ekleyip
          yeniden dağıtın.</div>`;
        return;
      }
      if (s.error) throw new Error(s.error);
      renderKpis(s.totals);
      renderBars(s.series);
      renderFeed(s.recent);
      board('top-queries', s.topQueries, { accent: 'amber' });
      board('top-symbols', s.topSymbols, { accent: 'cyan' });
      board('top-funds', s.topFunds, { accent: 'violet' });
      board('top-pages', s.topPages, { accent: 'amber' });
      board('top-countries', s.topCountries, { accent: 'up' });
      board('top-referrers', s.topReferrers, { accent: 'pink', empty: 'TÜMÜ DOĞRUDAN TRAFİK' });
      $('last-refresh').textContent = `GÜNCELLENDİ ${new Date().toLocaleTimeString('tr-TR', { hour12: false })}`;
    } catch (e) {
      $('last-refresh').textContent = `HATA: ${e.message}`;
    }
  }

  async function loadHealth() {
    try {
      $('health-age').textContent = 'SONDALANIYOR…';
      renderHealth(await call('/admin/health'));
    } catch (e) {
      $('health-list').innerHTML = `<div class="error-box">${UI.esc(e.message)}</div>`;
    } finally {
      $('health-age').textContent = '';
    }
  }

  function refreshAll() { loadStats(); loadHealth(); }

  function startTimers() {
    stopTimers();
    if (!auto) return;
    statsTimer = setInterval(loadStats, STATS_MS);
    healthTimer = setInterval(loadHealth, HEALTH_MS);
  }
  function stopTimers() {
    clearInterval(statsTimer);
    clearInterval(healthTimer);
    statsTimer = healthTimer = null;
  }

  // ---- kontroller --------------------------------------------------------

  $('refresh-btn').addEventListener('click', refreshAll);

  $('auto-toggle').addEventListener('click', () => {
    auto = !auto;
    $('auto-toggle').classList.toggle('active', auto);
    $('auto-toggle').textContent = auto ? 'OTO 10sn' : 'OTO KAPALI';
    startTimers();
  });
  $('auto-toggle').classList.add('active');

  document.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      days = Number(btn.dataset.days);
      loadStats();
    });
  });

  document.querySelectorAll('[data-reset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const scope = btn.dataset.reset;
      const msg = scope === 'all'
        ? 'TÜM analitik verisi silinecek — sayaçlar, listeler ve geçmiş. Geri alınamaz. Emin misiniz?'
        : `"${scope}" listesi temizlenecek. Geri alınamaz. Emin misiniz?`;
      if (!confirm(msg)) return;
      btn.disabled = true;
      try {
        await call('/admin/reset', { method: 'POST', body: JSON.stringify({ scope }) });
        await loadStats();
      } catch (e) {
        alert(`Sıfırlama başarısız: ${e.message}`);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Sekme görünmezken yoklamayı durdur — kimsenin bakmadığı bir pano için
  // Vercel çağrısı ve Upstash komutu harcamanın anlamı yok.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTimers();
    else if (session && !dash.hidden) { refreshAll(); startTimers(); }
  });

  // ---- açılış ------------------------------------------------------------

  if (session) {
    call('/admin/ping').then(enter).catch(() => { /* forceLogout zaten çalıştı */ });
  }
  codeInput.focus();
})();
