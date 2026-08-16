// Google News RSS client + lightweight lexicon-based sentiment scoring
// (Turkish + English financial vocabulary). Sentiment is a heuristic signal,
// not investment advice - the UI shows it as a green/red/gray dot.

const POSITIVE = [
  // Turkish
  'rekor', 'yükseldi', 'yükseliş', 'kazandı', 'kazanç', 'büyüme', 'büyüdü', 'kâr', 'kar açıkladı',
  'arttı', 'artış', 'olumlu', 'güçlü', 'temettü', 'anlaşma', 'imzaladı', 'ihale kazandı', 'yatırım',
  'hedef yükselt', 'tavan', 'prim', 'talep patlaması', 'ihracat rekoru', 'onay aldı', 'işbirliği',
  'sözleşme', 'teşvik', 'alım', 'geri alım', 'bedelsiz',
  // English
  'record', 'surge', 'soar', 'rally', 'beat', 'beats', 'profit', 'growth', 'gain', 'gains', 'upgrade',
  'outperform', 'strong', 'buyback', 'dividend', 'partnership', 'contract', 'approval', 'expansion',
  'raised guidance', 'all-time high', 'wins', 'award', 'breakthrough', 'bullish',
];

const NEGATIVE = [
  // Turkish
  'düştü', 'düşüş', 'geriledi', 'zarar', 'kayıp', 'dava', 'soruşturma', 'ceza', 'iflas', 'konkordato',
  'kriz', 'olumsuz', 'zayıf', 'taban', 'satış baskısı', 'borç', 'haciz', 'yaptırım', 'grev', 'istifa',
  'küçülme', 'işten çıkarma', 'hedef düşür', 'uyarı', 'manipülasyon', 'tedbir', 'yasak',
  // English
  'drop', 'falls', 'fell', 'plunge', 'slump', 'loss', 'losses', 'lawsuit', 'probe', 'investigation',
  'fine', 'penalty', 'bankruptcy', 'default', 'downgrade', 'underperform', 'weak', 'miss', 'misses',
  'layoff', 'layoffs', 'recall', 'strike', 'fraud', 'cut guidance', 'bearish', 'crash', 'sanction',
];

function sentiment(text) {
  const t = (text || '').toLocaleLowerCase('tr-TR');
  let score = 0;
  for (const w of POSITIVE) if (t.includes(w)) score++;
  for (const w of NEGATIVE) if (t.includes(w)) score--;
  const label = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
  return { label, score };
}

function decodeEntities(s) {
  return (s || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
  return m ? decodeEntities(m[1]) : null;
}

async function googleNews(q, lang = 'tr', limit = 12) {
  const isTr = lang !== 'en';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${isTr ? 'tr' : 'en-US'}&gl=${isTr ? 'TR' : 'US'}&ceid=${isTr ? 'TR:tr' : 'US:en'}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Google News responded ${res.status}`);
  const xml = await res.text();
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < limit) {
    const chunk = m[1];
    const title = tag(chunk, 'title');
    if (!title) continue;
    // Google News titles end with " - Source"; strip for cleaner sentiment input
    const cleanTitle = title.replace(/\s+-\s+[^-]+$/, '');
    items.push({
      title,
      link: tag(chunk, 'link'),
      source: tag(chunk, 'source'),
      date: tag(chunk, 'pubDate'),
      sentiment: sentiment(cleanTitle + ' ' + (tag(chunk, 'description') || '')),
    });
  }
  return items;
}

module.exports = { googleNews, sentiment };
