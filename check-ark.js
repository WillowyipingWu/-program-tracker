// Sanity check: is your Ark key + model configured correctly? Run with: npm run check
import { makeProviders } from '../lib/providers.js';

const need = ['ARK_API_KEY', 'ARK_MODEL'].filter(k => !process.env[k]);
if (need.length) {
  console.log(`❌ .env 里还没有填：${need.join('、')}`);
  process.exit(1);
}

const { llm } = makeProviders({ ...process.env, LLM_PROVIDER: 'ark' });
console.log(`模型：${process.env.ARK_MODEL}`);
console.log(`地址：${process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'}`);
console.log('正在发送一条测试消息……');

const t0 = Date.now();
try {
  const reply = await llm({ system: 'You are a helpful assistant.', user: 'Reply with exactly: OK' });
  console.log(`✅ 成功（${((Date.now() - t0) / 1000).toFixed(1)} 秒）。模型回复：${reply.trim().slice(0, 80)}`);
  console.log('可以运行 npm run dev 启动网站了。');
} catch (e) {
  console.log(`❌ 失败：${e.message}\n`);
  const m = e.message;
  if (/401|Unauthorized|AuthenticationError/i.test(m)) console.log('提示：API Key 不对或没复制完整。回到方舟控制台的 API Key 管理，用"小眼睛"图标复制完整的 Key。');
  else if (/404|NotFound|not.*exist|not.*open|ModelNotOpen/i.test(m)) console.log('提示：模型 ID 填错，或这个模型在你的账号里还没开通。去"开通管理"开通它，并确认 ARK_MODEL 和控制台里显示的完全一致。');
  else if (/429|Quota|Rate/i.test(m)) console.log('提示：额度用完或请求太频繁，去控制台查看额度和计费。');
  else if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONN/i.test(m)) console.log('提示：网络连不上方舟。检查网络，或代理软件是否影响了命令行。');
  process.exit(1);
}
