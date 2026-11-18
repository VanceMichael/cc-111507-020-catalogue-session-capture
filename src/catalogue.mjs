import { createHash, randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const DEFAULT_BATCH_SIZE = 2;
const MAX_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 3;
const MAX_PRESENTS_PER_ATTEMPT = 500;
const SUPPORTED_SYNTAXES = ['mods', 'marcxml'];

const xml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
});

const SET_ISSUE_MESSAGES = {
  'session-expired': '来源会话已失效，结果集随之作废',
  'set-replaced': '结果集被同名检索替换，旧序号不再有效',
  'set-exists': '结果集名称冲突',
  'session-unavailable': '无法建立来源会话',
  'search-failed': '检索请求失败',
  'search-invalid': '检索响应无法解释',
  'present-failed': '呈现请求失败',
  'present-empty': '结果集尚未取尽但来源返回空页',
  'present-no-progress': '来源呈现位置未推进',
  'present-limit': '呈现次数超出安全上限',
};

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'object') return String(node['#text'] ?? '').trim();
  return String(node).trim();
}

function attributeOf(node, name) {
  if (node === undefined || node === null || typeof node !== 'object') return null;
  const value = node[`@_${name}`];
  return value === undefined || value === null ? null : String(value);
}

function parseMods(body) {
  const doc = xml.parse(body);
  const mods = doc?.mods;
  if (!mods) throw new Error('MODS 正文缺少根元素');
  const title = textOf(asArray(asArray(mods.titleInfo)[0]?.title)[0]);
  const identifiers = asArray(mods.identifier)
    .map(node => ({ type: attributeOf(node, 'type'), value: textOf(node) }))
    .filter(item => item.value);
  return { title, identifiers };
}

function parseMarcxml(body) {
  const doc = xml.parse(body);
  const record = doc?.collection ? asArray(doc.collection.record)[0] : doc?.record;
  if (!record) throw new Error('MARCXML 正文缺少记录元素');
  const identifiers = [];
  for (const field of asArray(record.controlfield)) {
    if (attributeOf(field, 'tag') === '001') {
      const value = textOf(field);
      if (value) identifiers.push({ type: 'controlNumber', value });
    }
  }
  let title = '';
  for (const field of asArray(record.datafield)) {
    const tag = attributeOf(field, 'tag');
    const subfield = (code) => asArray(field.subfield).find(item => attributeOf(item, 'code') === code);
    if (tag === '245' && !title) title = textOf(subfield('a'));
    if (tag === '020') {
      const value = textOf(subfield('a'));
      if (value) identifiers.push({ type: 'isbn', value });
    }
  }
  return { title, identifiers };
}

// 解析一条 retrievalRecord。稳定身份取自正文标识，绝不使用结果序号；
// 正文缺少标识时退回正文摘要，保证身份仍然稳定且可追溯。
export function parseRetrievalRecord(retrieval) {
  const syntax = String(retrieval?.syntax ?? '').trim().toLowerCase();
  const body = String(retrieval?.body ?? '');
  if (!SUPPORTED_SYNTAXES.includes(syntax)) {
    return { supported: false, syntax: syntax || 'unknown', body };
  }
  const parsed = syntax === 'mods' ? parseMods(body) : parseMarcxml(body);
  const local = parsed.identifiers.find(item => item.type === 'local') ?? parsed.identifiers[0];
  const id = local?.value || `sha256:${createHash('sha256').update(body).digest('hex')}`;
  return { supported: true, syntax, body, id, title: parsed.title, identifiers: parsed.identifiers };
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, payload };
}

function diagnosticOf(result) {
  const code = result.payload?.operationDiagnostic?.code;
  if (code !== undefined && code !== null) return String(code);
  if (result.status !== 200) return `http-${result.status}`;
  return null;
}

// 结构化收件：open → search → 分批 present 直至取尽。
// 结果序号只在所属会话与当次检索（generation）内有意义；同名替换或会话失效时
// 重新开会话、重新检索并从位置 1 重来，有界重试，绝不把旧序号带进新检索。
export async function collectStructured({ input, descriptor, sourceBase, store }) {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) return { httpStatus: 400, error: '结构化收件需要检索式 query' };
  const preferredSyntax = typeof input.preferredSyntax === 'string' && input.preferredSyntax.trim()
    ? input.preferredSyntax.trim().toLowerCase()
    : 'mods';
  if (!SUPPORTED_SYNTAXES.includes(preferredSyntax)) {
    return { httpStatus: 400, error: `不支持的著录格式：${preferredSyntax}，当前支持 ${SUPPORTED_SYNTAXES.join('、')}` };
  }
  if (input.batchSize !== undefined
    && (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > MAX_BATCH_SIZE)) {
    return { httpStatus: 400, error: `分批大小无效，应为 1 到 ${MAX_BATCH_SIZE} 的整数` };
  }
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;

  // 每次采集独立会话、独立结果集名，并发采集互不覆盖。
  const resultSetName = `intake-${randomUUID()}`;
  const sessions = [];
  const generations = [];
  const transcript = [];
  const setIssues = [];
  const keptRecords = new Map();
  const keptRefusals = [];
  let resultCount = null;
  let completed = null;
  let attempts = 0;

  const recordIssue = (list, position, generation, code, message) => {
    list.push({ scope: 'record', position, generation, code, message });
  };
  const resultSetIssue = (attempt, generation, code) => {
    setIssues.push({
      scope: 'resultSet', attempt, generation, code,
      message: SET_ISSUE_MESSAGES[code] ?? `来源返回诊断：${code}`,
    });
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !completed; attempt += 1) {
    attempts = attempt;
    let session = null;
    try {
      const opened = await post(sourceBase, '/catalogue/open', {});
      session = opened.payload?.session ?? null;
    } catch { session = null; }
    if (!session) { resultSetIssue(attempt, null, 'session-unavailable'); continue; }
    sessions.push(session);

    let searched;
    try {
      searched = await post(sourceBase, '/catalogue/search', { session, resultSetName, query, replaceIndicator: true });
    } catch { resultSetIssue(attempt, null, 'search-failed'); continue; }
    transcript.push({ attempt, exchange: 'search', payload: searched.payload });
    const searchDiag = diagnosticOf(searched);
    if (searchDiag || !Number.isInteger(searched.payload?.resultCount)) {
      resultSetIssue(attempt, null, searchDiag ?? 'search-invalid');
      continue;
    }
    const generation = searched.payload.generation ?? null;
    resultCount = searched.payload.resultCount;
    generations.push(generation);

    const attemptRecords = new Map();
    const attemptRefusals = [];
    let start = 1;
    let invalidated = null;
    let presents = 0;
    while (!invalidated) {
      let shown;
      try {
        shown = await post(sourceBase, '/catalogue/present', { session, resultSetName, generation, start, count: batchSize, preferredSyntax });
      } catch { invalidated = 'present-failed'; break; }
      transcript.push({ attempt, exchange: 'present', start, payload: shown.payload });
      presents += 1;
      const presentDiag = diagnosticOf(shown);
      if (presentDiag) { invalidated = presentDiag; break; }
      const items = Array.isArray(shown.payload?.records) ? shown.payload.records : [];
      for (const item of items) {
        const position = Number.isInteger(item?.position) ? item.position : start;
        if (item?.surrogateDiagnostic) {
          const diagnostic = item.surrogateDiagnostic;
          recordIssue(attemptRefusals, position, generation,
            diagnostic.condition ?? diagnostic.code ?? 'unknown',
            String(diagnostic.message ?? '来源拒绝呈现该条目'));
          continue;
        }
        const retrieval = item?.retrievalRecord;
        if (!retrieval) {
          recordIssue(attemptRefusals, position, generation, 'empty-record', '来源返回了无法解释的空条目');
          continue;
        }
        let parsed;
        try {
          parsed = parseRetrievalRecord(retrieval);
        } catch {
          recordIssue(attemptRefusals, position, generation, 'record-unparsed', '著录正文无法解析，原文见收件证据');
          continue;
        }
        if (!parsed.supported) {
          recordIssue(attemptRefusals, position, generation, 'syntax-unsupported', `暂不支持的著录格式：${parsed.syntax}，原文见收件证据`);
          continue;
        }
        if (!attemptRecords.has(parsed.id)) {
          attemptRecords.set(parsed.id, {
            id: parsed.id,
            syntax: parsed.syntax,
            title: parsed.title,
            identifiers: parsed.identifiers,
            body: parsed.body,
            source: { position, generation, resultSetName },
          });
        }
      }
      const next = Number.isInteger(shown.payload?.nextResultSetPosition)
        ? shown.payload.nextResultSetPosition
        : start + items.length;
      // 不以首屏数量推断完成；只有 nextResultSetPosition 越过 resultCount（或空尾页）才算取尽。
      if (items.length === 0) {
        if (next > resultCount) break;
        invalidated = 'present-empty';
        break;
      }
      if (next <= start) { invalidated = 'present-no-progress'; break; }
      if (next > resultCount) break;
      if (presents >= MAX_PRESENTS_PER_ATTEMPT) { invalidated = 'present-limit'; break; }
      start = next;
    }
    for (const [id, record] of attemptRecords) {
      if (!keptRecords.has(id)) keptRecords.set(id, record);
    }
    keptRefusals.push(...attemptRefusals);
    if (invalidated) resultSetIssue(attempt, generation, invalidated);
    else completed = { records: [...attemptRecords.values()], refusals: attemptRefusals };
  }

  const exhausted = completed !== null;
  const records = exhausted ? completed.records : [...keptRecords.values()];
  const refusals = exhausted ? completed.refusals : keptRefusals;
  const issues = [...refusals, ...setIssues];
  const state = exhausted
    ? (refusals.length > 0 ? 'partial' : 'complete')
    : (records.length > 0 || refusals.length > 0 ? 'partial' : 'rejected');

  const evidencePayload = Buffer.from(JSON.stringify({
    query, preferredSyntax, resultSetName, sessions, generations, transcript,
  }, null, 2));
  const blob = await store.blob(evidencePayload);
  const receipt = await store.save({
    state,
    mode: 'structured',
    product: descriptor.product,
    source: descriptor.entry,
    sourceVersion: descriptor.version,
    metadata: { format: '联合目录会话资料', syntax: preferredSyntax, resultCount },
    blobs: [blob],
    records,
    issues,
    coverage: {
      structured: true,
      query,
      preferredSyntax,
      resultSetName,
      resultCount,
      batchSize,
      attempts,
      exhausted,
      recordsCollected: records.length,
      recordIssues: refusals.length,
      resultSetIssues: setIssues.length,
    },
    evidence: {
      transcript: blob.digest,
      sessions,
      generations,
      resultSetName,
      sourceVersion: descriptor.version,
    },
  });
  return { receipt };
}
