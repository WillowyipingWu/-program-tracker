// Prompt construction, JSON parsing, and — most importantly — evidence verification.
// The model must quote the page; we check the quote really is on the page and that
// dates match their quotes. Anything we can't verify is labelled, never silently trusted.

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

export function norm(s) {
  return String(s ?? '')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

export function buildPrompt(query, pages, today) {
  const system = [
    'You extract graduate-admissions facts from official web pages. Output ONE JSON object and nothing else.',
    'Rules:',
    '1. Use ONLY the page text provided. Never use outside knowledge. Never guess.',
    '2. For every item give "evidence": a short quote (max 30 words) copied VERBATIM from the page, and "source_url": the page it came from.',
    '3. If the pages do not state something, use null (or "unknown" for required) and leave evidence empty. Do not invent dates.',
    `4. Today is ${today}. Prefer deadlines for the next upcoming admission cycle; if a page lists several rounds, include each round as its own item.`,
    '5. Dates must be ISO YYYY-MM-DD. If the year is not stated, infer it only when unambiguous from the page; otherwise use null.',
    '6. Distinguish international-applicant deadlines from domestic ones in the label when the page does.',
    'Schema:',
    '{"university":string,"program":string,"degree":string,',
    ' "deadlines":[{"label":string,"date":"YYYY-MM-DD"|null,"evidence":string,"source_url":string}],',
    ' "materials":[{"item":string,"required":"yes"|"no"|"optional"|"unknown","detail":string,"evidence":string,"source_url":string}],',
    ' "facts":{"gre":{"value":string|null,"evidence":string,"source_url":string},',
    '   "english":{...same...},"letters":{...same...},"fee":{...same...}},',
    ' "warnings":[string]}',
    'In "materials" include: transcripts, statement/essay, resume/CV, letters of recommendation, test scores, interviews/video, prerequisites, anything else the page lists as part of the application.',
  ].join('\n');

  const body = pages.map((p, i) => `=== PAGE ${i + 1}: ${p.finalUrl} ===\n${p.text}`).join('\n\n');
  const user = `Program requested: ${query}\n\n${body}`;
  return { system, user };
}

export function parseModelJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON');
  return JSON.parse(text.slice(start, end + 1));
}

const str = (x, max = 400) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

function dateMatchesEvidence(evNorm, iso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (evNorm.includes(iso)) return true;
  const full = MONTHS[m - 1];
  const hasMonth = evNorm.includes(full) || evNorm.includes(full.slice(0, 3));
  const hasDay = new RegExp(`\\b0?${d}\\b`).test(evNorm);
  if (hasMonth && hasDay) return true;
  return new RegExp(`\\b0?${m}[/.-]0?${d}\\b`).test(evNorm);
}

function evidenceStatus(evidence, url, pages, hasValue) {
  const ev = norm(evidence);
  if (!ev) return hasValue ? 'unverified' : 'not_found';
  const page = pages.find(p => p.finalUrl === url || p.url === url);
  const pool = page ? [page.norm] : pages.map(p => p.norm);
  return pool.some(t => t.includes(ev)) ? 'verified' : 'unverified';
}

export function verify(raw, pages) {
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map(w => str(w, 300)).filter(Boolean) : [];
  const withNorm = pages.map(p => ({ ...p, norm: norm(p.text) }));
  const stat = { verified: 0, unverified: 0, not_found: 0 };
  const bump = s => { stat[s]++; return s; };

  const deadlines = [];
  for (const d of Array.isArray(raw.deadlines) ? raw.deadlines : []) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(d?.date ?? '') ? d.date : null;
    if (!date) { warnings.push(`已忽略没有明确日期的截止项：${str(d?.label, 80)}`); continue; }
    let status = evidenceStatus(d.evidence, d.source_url, withNorm, true);
    let note = '';
    if (status === 'verified' && !dateMatchesEvidence(norm(d.evidence), date)) {
      status = 'unverified'; note = '原文引用里找不到这个日期，请人工核对';
    }
    deadlines.push({ label: str(d.label, 120), date, evidence: str(d.evidence), source_url: str(d.source_url, 500), status: bump(status), note });
  }

  const materials = [];
  for (const m of Array.isArray(raw.materials) ? raw.materials : []) {
    const item = str(m?.item, 160);
    if (!item) continue;
    const required = ['yes', 'no', 'optional', 'unknown'].includes(m.required) ? m.required : 'unknown';
    const status = evidenceStatus(m.evidence, m.source_url, withNorm, true);
    materials.push({ item, required, detail: str(m.detail, 300), evidence: str(m.evidence), source_url: str(m.source_url, 500), status: bump(status) });
  }

  const facts = {};
  for (const key of ['gre', 'english', 'letters', 'fee']) {
    const f = raw.facts?.[key] ?? {};
    const value = f.value == null ? null : str(String(f.value), 300) || null;
    const status = evidenceStatus(f.evidence, f.source_url, withNorm, value !== null);
    facts[key] = { value, evidence: str(f.evidence), source_url: str(f.source_url, 500), status: bump(value === null && status !== 'verified' ? 'not_found' : status) };
  }

  return {
    data: { university: str(raw.university, 120), program: str(raw.program, 160), degree: str(raw.degree, 120), deadlines, materials, facts, warnings },
    stats: stat,
  };
}
