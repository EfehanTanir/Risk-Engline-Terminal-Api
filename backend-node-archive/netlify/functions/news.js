// GET /api/news?q=Turkish+Airlines&lang=tr  ->  Google News RSS + sentiment
const { googleNews } = require('../../lib/news');
const { json, badRequest, serverError, preflight } = require('../../lib/util');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  const params = event.queryStringParameters || {};
  if (!params.q) return badRequest('Missing query parameter: q');
  const lang = params.lang === 'en' ? 'en' : 'tr';

  try {
    const items = await googleNews(params.q, lang, 12);
    return json(200, { query: params.q, lang, items }, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    return serverError(err);
  }
};
