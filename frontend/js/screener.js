// F4 TEFAS Fund Screener: client-side filter/sort over the full fund universe
// (/api/funds). SERBEST (qualified-investor) funds are flagged in red.
(function () {
  const t = I18N.t.bind(I18N);
  let all = [];
  let sortKey = '1y';
  let sortDir = -1; // -1 desc, 1 asc
  const MAX_ROWS = 300;

  const elText = document.getElementById('f-text');
  const elCat = document.getElementById('f-cat');
  const elRmin = document.getElementById('f-rmin');
  const elRmax = document.getElementById('f-rmax');
  const tbl = document.getElementById('tbl');

  const RET_COLS = ['1m', '3m', '6m', 'ytd', '1y', '3y'];

  function trUpper(s) { return (s || '').toLocaleUpperCase('tr-TR'); }

  function getVal(f, key) {
    if (key === 'code') return f.code;
    if (key === 'title') return f.title || '';
    if (key === 'category') return f.category || '';
    if (key === 'risk') return f.riskValue != null ? Number(f.riskValue) : null;
    return f.returns ? f.returns[key] : null;
  }

  function apply() {
    const q = trUpper(elText.value.trim());
    const cat = elCat.value;
    const rmin = Number(elRmin.value), rmax = Number(elRmax.value);
    let view = all.filter((f) => {
      if (q && !trUpper(f.code).includes(q) && !trUpper(f.title).includes(q)) return false;
      if (cat && f.category !== cat) return false;
      const rv = f.riskValue != null ? Number(f.riskValue) : null;
      if (rv != null && (rv < rmin || rv > rmax)) return false;
      if (rv == null && (rmin > 1 || rmax < 7)) return false;
      return true;
    });
    view.sort((a, b) => {
      const va = getVal(a, sortKey), vb = getVal(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;               // nulls always last
      if (vb == null) return -1;
      if (typeof va === 'string') return sortDir * va.localeCompare(vb, 'tr');
      return sortDir * (va - vb);
    });
    render(view);
  }

  function sortArrow(key) {
    return sortKey === key ? (sortDir === -1 ? ' ▼' : ' ▲') : '';
  }

  function render(view) {
    document.getElementById('count').textContent = t('scr.count', { n: view.length });
    const th = (key, label, cls = '') =>
      `<th class="sortable ${sortKey === key ? 'sorted' : ''} ${cls}" data-k="${key}">${label}${sortArrow(key)}</th>`;
    const retCell = (v) => v == null
      ? '<td class="faint">—</td>'
      : `<td class="${UI.chgClass(v)}">${UI.fmtPctRaw(v, 1)}</td>`;

    const rows = view.slice(0, MAX_ROWS).map((f) => {
      const isSerbest = /SERBEST/i.test(`${f.category || ''} ${f.title || ''}`);
      const rv = f.riskValue != null ? Number(f.riskValue) : null;
      const riskColor = rv == null ? 'var(--faint)' : rv >= 6 ? 'var(--down)' : rv >= 4 ? 'var(--amber)' : 'var(--up)';
      return `<tr class="rowlink" data-code="${UI.esc(f.code)}">
        <td class="amber" style="font-weight:700">${UI.esc(f.code)}</td>
        <td style="text-align:left;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${UI.esc(f.title)}">${UI.esc(f.title)}</td>
        <td style="text-align:left;white-space:nowrap" class="${isSerbest ? 'down' : 'muted'}">${UI.esc(f.category || '—')}</td>
        <td><span class="risk-badge" style="border-color:${riskColor};color:${riskColor}">${rv ?? '—'}</span></td>
        ${RET_COLS.map((k) => retCell(f.returns ? f.returns[k] : null)).join('')}
      </tr>`;
    }).join('');

    tbl.innerHTML = `<tr>
      ${th('code', t('th.code'))}
      ${th('title', t('th.fund'))}
      ${th('category', t('th.cat'))}
      ${th('risk', t('scr.risk'))}
      ${th('1m', t('col.1m'))}${th('3m', t('col.3m'))}${th('6m', t('col.6m'))}
      ${th('ytd', t('col.ytd'))}${th('1y', t('col.1y'))}${th('3y', t('col.3y'))}
    </tr>${rows || `<tr><td class="faint" style="text-align:left;padding:16px">${t('risk.nomatch')}</td></tr>`}`;

    tbl.querySelectorAll('th.sortable').forEach((el) => {
      el.addEventListener('click', () => {
        const k = el.dataset.k;
        if (sortKey === k) sortDir = -sortDir;
        else { sortKey = k; sortDir = ['code', 'title', 'category'].includes(k) ? 1 : -1; }
        apply();
      });
    });
    tbl.querySelectorAll('tr.rowlink').forEach((el) => {
      el.addEventListener('click', () => { location.href = `fund.html?code=${encodeURIComponent(el.dataset.code)}`; });
    });
  }

  async function init() {
    try {
      const { funds } = await API.funds();
      all = funds || [];
      const cats = [...new Set(all.map((f) => f.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
      elCat.innerHTML = `<option value="">${t('scr.all')}</option>` +
        cats.map((c) => `<option value="${UI.esc(c)}">${UI.esc(c)}</option>`).join('');
      apply();
    } catch (err) {
      tbl.innerHTML = `<tr><td class="error-box" style="text-align:left">${UI.esc(err.message)}</td></tr>`;
    }
  }

  elText.addEventListener('input', UI.debounce(apply, 200));
  elCat.addEventListener('change', apply);
  elRmin.addEventListener('change', apply);
  elRmax.addEventListener('change', apply);
  init();
})();
