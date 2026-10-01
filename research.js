// The pipeline: find official URLs -> fetch the real pages -> extract with quotes -> verify quotes.
import { fetchPage } from './fetchPage.js';
import { buildPrompt, parseModelJson, verify } from './extract.js';

const PAGE_BUDGET = 45000; // total characters sent to the model
const BAD_HOSTS = /(linkedin|facebook|reddit|youtube|quora|zhihu|xiaohongshu|twitter|instagram|yocket|shiksha|leverageedu|gradcafe|collegevine|studyabroad)/i;

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

export function rank(cands) {
  const seen = new Set();
  return cands
    .filter(c => { try { return !BAD_HOSTS.test(new URL(c.url).hostname); } catch { return false; } })
    .filter(c => !seen.has(c.url) && seen.add(c.url))
    .map(c => {
      const u = new URL(c.url);
      let score = 0;
      if (/\.edu(\.|$)/i.test(u.hostname)) score += 3;
      score += (u.pathname.toLowerCase().match(/admission|apply|graduate|deadline|requirement|program|master|\bms\b/g) || []).length;
      if (/\.pdf$/i.test(u.pathname)) score -= 3;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
}

export async function research({ query, urls = [] }, { llm, search, allowPrivate = false, today = new Date().toISOString().slice(0, 10) }) {
  let candidates = urls.map(url => ({ url, title: '(用户提供)' }));
  if (!candidates.length) {
    candidates = rank(await search(query)).slice(0, 5);
    if (!candidates.length) throw new HttpError(422, '没能自动找到官网页面，请在"官网链接"里粘贴该项目的招生要求页面。');
  }

  const settled = await Promise.allSettled(candidates.map(c => fetchPage(c.url, { allowPrivate })));
  const failures = [];
  const pages = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.text.length >= 300) pages.push({ ...r.value, title: candidates[i].title });
    else failures.push(`${candidates[i].url}：${r.status === 'rejected' ? r.reason.message : '页面正文太短（可能由 JavaScript 动态渲染）'}`);
  });
  const used = pages.slice(0, 3);
  if (!used.length) throw new HttpError(422, `官网页面都没能读取成功。\n${failures.join('\n')}`);

  const per = Math.floor(PAGE_BUDGET / used.length);
  const truncated = used.some(p => p.text.length > per);
  const sent = used.map(p => ({ ...p, text: p.text.slice(0, per) }));

  const { system, user } = buildPrompt(query, sent, today);
  let raw, lastParseErr;
  for (let attempt = 0; attempt < 2 && !raw; attempt++) {
    let text;
    try {
      text = await llm({ system, user: attempt ? `${user}\n\n(Your previous reply was not valid JSON. Reply with JSON only.)` : user });
    } catch (e) {
      // A transport/auth/quota failure from the provider (wrong key, model not enabled, no
      // credit, etc.) won't be fixed by re-asking, so fail immediately with a message that
      // points at the key/model rather than retrying and masking it as a "bad JSON" error.
      throw new HttpError(502, `调用模型失败：${e.message}`, 'upstream_error');
    }
    try { raw = parseModelJson(text); } catch (e) { lastParseErr = e; }
  }
  if (!raw) throw new HttpError(502, `模型没有返回合规的 JSON：${lastParseErr?.message}`, 'bad_model_output');

  const { data, stats } = verify(raw, sent);
  if (truncated) data.warnings.push('部分页面内容过长已被截断，可能遗漏信息。');
  for (const f of failures) data.warnings.push(`未能读取：${f}`);

  return {
    query,
    generatedAt: new Date().toISOString(),
    sources: sent.map(p => ({ url: p.finalUrl, title: p.title, chars: p.text.length })),
    stats,
    data,
  };
}
