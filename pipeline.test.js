import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { htmlToText } from '../lib/fetchPage.js';
import { assertPublicUrl } from '../lib/ssrf.js';
import { verify, parseModelJson } from '../lib/extract.js';
import { research, rank } from '../lib/research.js';

const PAGE = `<html><head><style>.x{color:red}</style><script>var secret=1</script></head><body>
<h1>MS in Operations Research</h1>
<p>The application deadline for Fall 2027 is January 15, 2027 for all applicants.</p>
<ul><li>Three letters of recommendation are required.</li><li>GRE scores are not considered.</li></ul>
<p>Application fee: $90. ${'Filler text about campus life. '.repeat(20)}</p></body></html>`;

function startServer() {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('htmlToText drops scripts/styles and keeps content', () => {
  const t = htmlToText(PAGE);
  assert.match(t, /application deadline for Fall 2027 is January 15, 2027/);
  assert.doesNotMatch(t, /secret|color:red/);
});

test('SSRF guard blocks internal targets', async () => {
  for (const u of ['http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://localhost/', 'file:///etc/passwd']) {
    await assert.rejects(() => assertPublicUrl(u), undefined, u);
  }
});

test('parseModelJson tolerates code fences', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('verify: real quotes verified, fabricated quotes and wrong dates flagged', () => {
  const pages = [{ url: 'http://a/', finalUrl: 'http://a/', text: htmlToText(PAGE) }];
  const raw = {
    deadlines: [
      { label: 'Fall', date: '2027-01-15', evidence: 'deadline for Fall 2027 is January 15, 2027', source_url: 'http://a/' },
      { label: 'Wrong date', date: '2027-02-01', evidence: 'deadline for Fall 2027 is January 15, 2027', source_url: 'http://a/' },
      { label: 'Made up', date: '2027-03-01', evidence: 'priority deadline is March 1', source_url: 'http://a/' },
      { label: 'No date', date: null, evidence: '', source_url: '' },
    ],
    materials: [{ item: 'Letters', required: 'yes', detail: '3', evidence: 'Three letters of recommendation are required.', source_url: 'http://a/' }],
    facts: { gre: { value: 'Not considered', evidence: 'GRE scores are not considered.', source_url: 'http://a/' }, fee: { value: '$100', evidence: 'Application fee: $100', source_url: 'http://a/' }, english: { value: null, evidence: '', source_url: '' } },
  };
  const { data, stats } = verify(raw, pages);
  assert.equal(data.deadlines.length, 3);
  assert.equal(data.deadlines[0].status, 'verified');
  assert.equal(data.deadlines[1].status, 'unverified');
  assert.match(data.deadlines[1].note, /日期/);
  assert.equal(data.deadlines[2].status, 'unverified');
  assert.equal(data.materials[0].status, 'verified');
  assert.equal(data.facts.gre.status, 'verified');
  assert.equal(data.facts.fee.status, 'unverified');
  assert.equal(data.facts.english.status, 'not_found');
  assert.ok(data.warnings.some(w => w.includes('No date')));
  assert.ok(stats.verified >= 3);
});

test('rank drops forum/agency sites and prefers .edu admissions pages', () => {
  const r = rank([
    { url: 'https://www.reddit.com/r/gradadmissions/x' },
    { url: 'https://yocket.com/universities/foo' },
    { url: 'https://example.com/blog' },
    { url: 'https://engineering.example.edu/graduate/admissions/deadlines' },
  ]);
  assert.equal(r[0].url, 'https://engineering.example.edu/graduate/admissions/deadlines');
  assert.ok(!r.some(x => /reddit|yocket/.test(x.url)));
});

test('end-to-end with a local page and a fake model', async () => {
  const server = await startServer();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const llm = async () => JSON.stringify({
    university: 'Test U', program: 'MS OR', degree: 'MS',
    deadlines: [{ label: 'Fall 2027', date: '2027-01-15', evidence: 'January 15, 2027 for all applicants', source_url: url }],
    materials: [{ item: 'Letters of recommendation', required: 'yes', detail: '3', evidence: 'Three letters of recommendation are required.', source_url: url }],
    facts: { gre: { value: 'Not considered', evidence: 'GRE scores are not considered.', source_url: url }, english: { value: null }, letters: { value: '3', evidence: 'Three letters', source_url: url }, fee: { value: '$90', evidence: 'Application fee: $90', source_url: url } },
    warnings: [],
  });
  try {
    const out = await research({ query: 'Test U MS OR', urls: [url] }, { llm, search: async () => [], allowPrivate: true, today: '2026-09-28' });
    assert.equal(out.data.deadlines[0].status, 'verified');
    assert.equal(out.stats.unverified, 0);
    assert.equal(out.sources.length, 1);
  } finally { server.close(); }
});

test('end-to-end: private URLs are refused by default; no search hits gives a helpful 422', async () => {
  await assert.rejects(() => research({ query: 'x y z', urls: ['http://127.0.0.1:1/'] }, { llm: async () => '{}', search: async () => [] }), /官网页面都没能读取成功/);
  await assert.rejects(() => research({ query: 'x y z' }, { llm: async () => '{}', search: async () => [] }), e => e.status === 422);
});

test('model returning garbage twice yields a 502 (bad_model_output)', async () => {
  const server = await startServer();
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await assert.rejects(() => research({ query: 'x y z', urls: [url] }, { llm: async () => 'sorry, no json', search: async () => [], allowPrivate: true }),
      e => e.status === 502 && e.code === 'bad_model_output');
  } finally { server.close(); }
});

test('a transport/auth failure from the provider fails fast with upstream_error (no masking as bad JSON)', async () => {
  const server = await startServer();
  const url = `http://127.0.0.1:${server.address().port}/`;
  let calls = 0;
  try {
    await assert.rejects(
      () => research({ query: 'x y z', urls: [url] }, { llm: async () => { calls++; throw new Error('上游接口错误 401: bad key'); }, search: async () => [], allowPrivate: true }),
      e => e.status === 502 && e.code === 'upstream_error' && /401/.test(e.message)
    );
    assert.equal(calls, 1, 'should not retry a transport/auth failure');
  } finally { server.close(); }
});
