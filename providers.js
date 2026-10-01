// Model + search providers. Both are tiny wrappers over plain HTTPS so there are no dependencies.
// NOTE: the Ark (Doubao) request shapes below follow Volcano Engine's OpenAI-compatible API,
// but verify model names / endpoints against the current Ark docs before deploying.

const post = async (url, headers, body, ms = 120000) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`上游接口错误 ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

const need = (env, name) => {
  if (!env[name]) throw new Error(`缺少环境变量 ${name}`);
  return env[name];
};

const URL_RE = /https?:\/\/[^\s"'<>\\)\]]+/g;

// env is normally process.env for a host's own test run (scripts/check-ark.js), but in the
// BYOK server flow it is a per-request object built in server.js: the API key and model
// come from the visitor's request, while ARK_BASE_URL always comes from this process's own
// env/default — never from a client — to avoid turning the server into an open SSRF relay.
export function makeProviders(env = process.env) {
  const llmName = env.LLM_PROVIDER || 'ark';
  const searchName = env.SEARCH_PROVIDER || 'none';

  const llms = {
    ark: async ({ system, user }) => {
      const base = env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
      const j = await post(`${base}/chat/completions`, { authorization: `Bearer ${need(env, 'ARK_API_KEY')}` }, {
        model: need(env, 'ARK_MODEL'), temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return j.choices?.[0]?.message?.content ?? '';
    },
    anthropic: async ({ system, user }) => {
      const j = await post('https://api.anthropic.com/v1/messages',
        { 'x-api-key': need(env, 'ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }, {
          model: env.ANTHROPIC_MODEL || 'claude-sonnet-5', max_tokens: 4096, temperature: 0,
          system, messages: [{ role: 'user', content: user }],
        });
      return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    },
  };

  const searches = {
    none: async () => [],
    anthropic: async (query) => {
      const j = await post('https://api.anthropic.com/v1/messages',
        { 'x-api-key': need(env, 'ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }, {
          model: env.ANTHROPIC_MODEL || 'claude-sonnet-5', max_tokens: 1024,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          messages: [{ role: 'user', content: `Find the OFFICIAL university admissions/requirements/deadlines pages for: ${query}. Just search; no summary needed.` }],
        });
      const out = [];
      for (const b of j.content || []) {
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
          for (const r of b.content) if (r.url) out.push({ url: r.url, title: r.title || '' });
        }
      }
      return out;
    },
    // UNVERIFIED shape: Ark Responses API with the web_search tool. We only harvest URLs
    // from whatever comes back, so small response-format differences don't break it.
    ark: async (query) => {
      const base = env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
      const j = await post(`${base}/responses`, { authorization: `Bearer ${need(env, 'ARK_API_KEY')}` }, {
        model: need(env, 'ARK_MODEL'),
        input: [{ role: 'user', content: [{ type: 'input_text', text: `Find official university admissions pages (requirements, deadlines) for: ${query}. List the page URLs.` }] }],
        tools: [{ type: 'web_search' }],
      });
      const urls = [...new Set(JSON.stringify(j).match(URL_RE) || [])];
      return urls.map(url => ({ url, title: '' }));
    },
  };

  const llm = llms[llmName];
  const search = searches[searchName];
  if (!llm) throw new Error(`未知的 LLM_PROVIDER: ${llmName}`);
  if (!search) throw new Error(`未知的 SEARCH_PROVIDER: ${searchName}`);
  return { llm, search, info: { llm: llmName, search: searchName } };
}
