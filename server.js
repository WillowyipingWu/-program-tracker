import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeProviders } from './lib/providers.js';
import { research, HttpError } from './lib/research.js';
import { getCached, putCached } from './lib/cache.js';
import { allow } from './lib/ratelimit.js';

const PORT = Number(process.env.PORT || 3000);
const LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || 20);
const TTL = Number(process.env.CACHE_TTL_DAYS || 7);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC = path.resolve('public');

// BYOK (Bring Your Own Key): each visitor supplies their own provider + API key in the
// browser. The server never holds a shared key for public use — see README "AI Key".
// The only things that may come from the host's own .env are non-secret defaults
// (which provider to offer, which model name to assume) so visitors don't have to type
// a model ID every time. ARK_BASE_URL is intentionally NEVER accepted from the client:
// letting a caller redirect our server's outbound requests to an arbitrary URL would be
// an SSRF vector, so the base URL is fixed by the host (or the Ark default) only.
function resolveProviderEnv(body) {
  const provider = body.provider === 'anthropic' ? 'anthropic' : 'ark';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) throw new HttpError(400, '请先在设置里填写你的 API Key', 'missing_api_key');
  if (apiKey.length > 300) throw new HttpError(400, 'API Key 格式不正确', 'missing_api_key');
  const clientModel = typeof body.model === 'string' ? body.model.trim().slice(0, 200) : '';
  const useSearch = !!body.useSearch;

  const env = { ...process.env, LLM_PROVIDER: provider, SEARCH_PROVIDER: useSearch ? provider : 'none' };
  if (provider === 'ark') {
    env.ARK_API_KEY = apiKey;
    env.ARK_MODEL = clientModel || process.env.ARK_MODEL || '';
    if (!env.ARK_MODEL) throw new HttpError(400, '请填写模型名称（方舟的 Model ID 或 ep- 接入点）', 'missing_model');
    // ARK_BASE_URL comes only from process.env / the lib default — never from the request body.
  } else {
    env.ANTHROPIC_API_KEY = apiKey;
    env.ANTHROPIC_MODEL = clientModel || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  }
  return env;
}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readBody = (req, max = 20_000) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > max) { reject(new HttpError(413, '请求太大')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const clientIp = req => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

async function handleResearch(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, '请求格式不正确'); }
  const query = String(body.query || '').trim().slice(0, 200);
  const urls = (Array.isArray(body.urls) ? body.urls : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 3);
  if (query.length < 3) throw new HttpError(400, '请输入学校和项目名称，例如 "Michigan IOE MS"');

  const cached = await getCached(query, urls, TTL);
  if (cached) return send(res, 200, { ...cached, cached: true });

  // Rate limiting here protects the SERVER's own bandwidth/CPU (fetching pages, running the
  // pipeline) — it is not about AI cost, since every visitor pays for their own API calls.
  if (!allow(clientIp(req), LIMIT)) throw new HttpError(429, `查询太频繁，每小时最多 ${LIMIT} 次（缓存命中不计次数）`);

  const env = resolveProviderEnv(body); // throws 400 missing_api_key / missing_model
  const providers = makeProviders(env);
  const result = await research({ query, urls }, { ...providers, allowPrivate: process.env.ALLOW_PRIVATE_URLS === '1' });
  await putCached(query, urls, result);
  send(res, 200, { ...result, cached: false });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/research') return await handleResearch(req, res);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        // Non-secret: which providers this deployment offers and the host's optional
        // default model name per provider, so the frontend can pre-fill the model field.
        providers: ['ark', 'anthropic'],
        defaultProvider: process.env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'ark',
        defaultModel: { ark: process.env.ARK_MODEL || null, anthropic: process.env.ANTHROPIC_MODEL || null },
      });
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
      try { return send(res, 200, await fs.readFile(file), file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream'); }
      catch { return send(res, 404, { error: 'not found' }); }
    }
    send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message || '服务器错误', code: e.code });
  }
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}  (BYOK: visitors supply their own API key)`));
