// gist-proxy.js
//
// Shared serverless proxy for the family budget apps (Carsen, Chandler, Hannah).
// The real GitHub token lives ONLY here, as a Netlify environment variable
// (GIST_PROXY_TOKEN) — it is never shipped to any browser. The apps call this
// function instead of api.github.com directly, and identify themselves with
// a shared secret (GIST_PROXY_SECRET) instead of the real token.
//
// Request body (POST, JSON):
//   { secret: "...", action: "load" | "save", gistId: "...", file: "...", data: {...} }
// "data" is required only for action "save".

const GITHUB_TOKEN = process.env.GIST_PROXY_TOKEN;
const PROXY_SECRET = process.env.GIST_PROXY_SECRET;

// Allow calls from the family apps' actual domains only.
const ALLOWED_ORIGINS = [
  'https://carsen-dashboard.netlify.app',
  'https://hatchchuck.github.io',
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function githubFetch(url, opts, { retries = 2, timeoutMs = 12000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
        lastErr = new Error('github-transient-' + resp.status);
        await new Promise(r => setTimeout(r, 600 * Math.pow(2, attempt)));
        continue;
      }
      return resp;
    } catch (e) {
      clearTimeout(timer);
      const retryable = e.name === 'AbortError' || e instanceof TypeError;
      if (retryable && attempt < retries) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 600 * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!GITHUB_TOKEN || !PROXY_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Proxy not configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { secret, action, gistId, file, data } = payload;

  if (secret !== PROXY_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!gistId || !file || (action !== 'load' && action !== 'save')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing or invalid parameters' }) };
  }

  const GIST_URL = 'https://api.github.com/gists/' + gistId;

  try {
    if (action === 'load') {
      const resp = await githubFetch(GIST_URL, {
        headers: {
          'Authorization': 'token ' + GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
        },
      });
      if (!resp.ok) {
        return { statusCode: resp.status, headers, body: JSON.stringify({ error: 'GitHub error ' + resp.status }) };
      }
      const gistData = await resp.json();
      const content = gistData.files?.[file]?.content ?? null;
      return { statusCode: 200, headers, body: JSON.stringify({ content }) };
    }

    // action === 'save'
    const body = { files: {} };
    body.files[file] = { content: JSON.stringify(data) };
    const resp = await githubFetch(GIST_URL, {
      method: 'PATCH',
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: 'GitHub error ' + resp.status }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || 'Upstream request failed' }) };
  }
};
