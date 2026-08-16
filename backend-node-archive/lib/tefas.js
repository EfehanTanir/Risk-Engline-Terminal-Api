// TEFAS (Turkish mutual fund platform) client.
// Talks to the same JSON endpoints the tefas-crawler Python library wraps:
//   POST https://www.tefas.gov.tr/api/DB/BindHistoryInfo        (price history)
//   POST https://www.tefas.gov.tr/api/DB/BindHistoryAllocation  (portfolio breakdown)
//   POST https://www.tefas.gov.tr/api/DB/BindComparisonFundReturns (fund universe + returns)
// TEFAS caps history queries at ~3 months, so long ranges are fetched in chunks.

const BASE = 'https://www.tefas.gov.tr/api/DB';

const TEFAS_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': 'https://www.tefas.gov.tr',
  'Referer': 'https://www.tefas.gov.tr/TarihselVeriler.aspx',
};

function fmtDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function isoDate(msOrDate) {
  const d = new Date(Number(msOrDate));
  return d.toISOString().slice(0, 10);
}

async function tefasPost(path, params) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: TEFAS_HEADERS,
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`TEFAS ${path} responded ${res.status}`);
  return res.json();
}

// ---- Fund universe (cached ~6h across warm invocations) -----------------

let fundListCache = { t: 0, data: null };

async function fundList() {
  const now = Date.now();
  if (fundListCache.data && now - fundListCache.t < 6 * 3600 * 1000) return fundListCache.data;
  const end = new Date();
  const start = new Date(now - 7 * 24 * 3600 * 1000);
  const body = {
    calismatipi: '2',
    fontip: 'YAT',
    sfontur: '',
    kurucukod: '',
    fongrup: '',
    bastarih: fmtDate(start),
    bittarih: fmtDate(end),
    fonturkod: '',
    fonunvantip: '',
    strperiod: '1,1,1,1,1,1,1',
    islemdurum: '1',
  };
  const resp = await tefasPost('BindComparisonFundReturns', body);
  const rows = (resp && resp.data) || [];
  const data = rows.map((r) => ({
    code: r.FONKODU,
    title: r.FONUNVAN,
    category: r.FONTURACIKLAMA || null,
    returns: {
      '1m': numOrNull(r.GETIRI1A),
      '3m': numOrNull(r.GETIRI3A),
      '6m': numOrNull(r.GETIRI6A),
      ytd: numOrNull(r.GETIRIYB !== undefined ? r.GETIRIYB : r.GETIRIYIL),
      '1y': numOrNull(r.GETIRI1Y),
      '3y': numOrNull(r.GETIRI3Y),
      '5y': numOrNull(r.GETIRI5Y),
    },
  })).filter((f) => f.code);
  fundListCache = { t: now, data };
  return data;
}

function numOrNull(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

async function searchFunds(q, limit = 12) {
  const list = await fundList();
  const qq = q.toLocaleUpperCase('tr-TR');
  const codeHits = list.filter((f) => f.code.toLocaleUpperCase('tr-TR').startsWith(qq));
  const nameHits = list.filter(
    (f) => !codeHits.includes(f) && (f.title || '').toLocaleUpperCase('tr-TR').includes(qq)
  );
  return [...codeHits, ...nameHits].slice(0, limit);
}

// ---- Price history ------------------------------------------------------

async function fundHistory(code, days = 365) {
  const end = new Date();
  const start = new Date(Date.now() - days * 24 * 3600 * 1000);
  const CHUNK = 60 * 24 * 3600 * 1000; // TEFAS limits each query window
  const requests = [];
  for (let t = start.getTime(); t < end.getTime(); t += CHUNK) {
    const cs = new Date(t);
    const ce = new Date(Math.min(t + CHUNK - 24 * 3600 * 1000, end.getTime()));
    requests.push(tefasPost('BindHistoryInfo', {
      fontip: 'YAT', sfontur: '', fonkod: code.toLocaleUpperCase('tr-TR'),
      fongrup: '', bastarih: fmtDate(cs), bittarih: fmtDate(ce),
      fonturkod: '', fonunvantip: '',
    }).catch(() => ({ data: [] })));
  }
  const chunks = await Promise.all(requests);
  const byDate = {};
  let title = null;
  for (const chunk of chunks) {
    for (const row of (chunk && chunk.data) || []) {
      const date = isoDate(row.TARIH);
      const price = Number(row.FIYAT);
      if (!isFinite(price) || price <= 0) continue;
      byDate[date] = {
        date,
        price,
        aum: numOrNull(row.PORTFOYBUYUKLUGU),
        investors: numOrNull(row.KISISAYISI),
        shares: numOrNull(row.TEDPAYSAYISI),
      };
      if (row.FONUNVAN) title = row.FONUNVAN;
    }
  }
  const history = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  return { title, history };
}

// ---- Portfolio allocation ----------------------------------------------

const ALLOCATION_LABELS = {
  BB: 'Bank Bills', BYF: 'ETFs', D: 'Other', DB: 'FX Bills', DT: 'Government Bonds',
  DÖT: 'FX-Payable Bonds', EUT: 'Eurobonds', FB: 'Fund Participation', FKB: 'Lease Certificates (Foreign)',
  GAS: 'Real Estate Certificates', GSYKB: 'Venture Capital Inv.', GYKB: 'Real Estate Inv.',
  HB: 'Treasury Bills', HS: 'Equities', KBA: 'Precious Metal Bills', KH: 'Public Lease Certificates',
  KKS: 'Private Lease Certificates', KM: 'Precious Metals', KMKB: 'Precious Metal Lease Cert.',
  OSA: 'Private Sector Lease Cert.', OST: 'Corporate Bonds', R: 'Repo', T: 'Bills',
  TPP: 'FX Deposit/Participation', TR: 'Reverse Repo', VM: 'Term Deposit',
  VDM: 'Term Deposit', Vİ: 'Derivatives', YBA: 'Foreign Bank Bills', YBOSB: 'Foreign Corporate Debt',
  YHS: 'Foreign Equities', YMK: 'Foreign Securities', YYF: 'Foreign Funds', TDÖT: 'Gov. FX Bonds',
};

async function fundAllocation(code) {
  const end = new Date();
  const start = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  const resp = await tefasPost('BindHistoryAllocation', {
    fontip: 'YAT', sfontur: '', fonkod: code.toLocaleUpperCase('tr-TR'),
    fongrup: '', bastarih: fmtDate(start), bittarih: fmtDate(end),
    fonturkod: '', fonunvantip: '',
  });
  const rows = (resp && resp.data) || [];
  if (!rows.length) return null;
  rows.sort((a, b) => Number(a.TARIH) - Number(b.TARIH));
  const latest = rows[rows.length - 1];
  const skip = new Set(['TARIH', 'FONKODU', 'FONUNVAN', 'BilFiyat']);
  const slices = [];
  for (const [key, value] of Object.entries(latest)) {
    if (skip.has(key)) continue;
    const pct = Number(value);
    if (isFinite(pct) && pct > 0.01) {
      slices.push({ code: key, label: ALLOCATION_LABELS[key] || key, pct });
    }
  }
  slices.sort((a, b) => b.pct - a.pct);
  return { date: isoDate(latest.TARIH), slices };
}

module.exports = { fundList, searchFunds, fundHistory, fundAllocation };
