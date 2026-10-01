import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = path.resolve('.cache');

const keyOf = (query, urls) =>
  crypto.createHash('sha256').update(JSON.stringify([query.toLowerCase().replace(/\s+/g, ' ').trim(), [...urls].sort()])).digest('hex').slice(0, 32);

export async function getCached(query, urls, ttlDays) {
  try {
    const file = path.join(DIR, `${keyOf(query, urls)}.json`);
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs > ttlDays * 86400000) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

export async function putCached(query, urls, value) {
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(path.join(DIR, `${keyOf(query, urls)}.json`), JSON.stringify(value));
  } catch { /* cache is best-effort */ }
}
