const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=60',
};

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function badRequest(msg) {
  return json(400, { error: msg }, { 'Cache-Control': 'no-store' });
}

function serverError(err) {
  console.error(err);
  return json(502, { error: String((err && err.message) || err) }, { 'Cache-Control': 'no-store' });
}

function preflight() {
  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}

module.exports = { json, badRequest, serverError, preflight };
