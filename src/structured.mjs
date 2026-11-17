import { randomUUID } from 'node:crypto';
import { openSession, searchCatalogue, presentCatalogue } from './catalogue-client.mjs';
import { parseRetrievalRecord } from './catalogue-records.mjs';

const MAX_PAGES = 1000;
const MAX_RECORDS = 10000;
const DEFAULT_PAGE_SIZE = 2;
const DEFAULT_SYNTAX = 'mods';

function normalisePageSize(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_PAGE_SIZE;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100) throw new Error('每批领取数量必须是 1 到 100 之间的整数');
  return number;
}

function normaliseResultSetName(value) {
  if (value === undefined || value === null || value === '') return `intake-${randomUUID()}`;
  if (typeof value !== 'string' || !/^[\w.:-]{1,64}$/u.test(value)) throw new Error('结果集名称无效');
  return value;
}

function operationIssue(operation, extra) {
  return {
    scope: 'result-set',
    kind: 'result-set-invalid',
    code: operation.code,
    message: operationMessage(operation),
    phase: operation.phase,
    status: operation.status,
    sourceDiagnostic: operation.detail,
    ...extra,
  };
}

function operationMessage(operation) {
  const code = operation.code;
  if (code === 'session-expired') return '来源会话或结果集已失效，须重新搜索后才可继续呈现';
  if (code === 'set-replaced') return '结果集已被同名检索替换，原有序号不可再用于领取';
  if (operation.phase === 'open') return '无法建立来源检索会话';
  if (operation.phase === 'search') return '来源检索失败，无法建立结果集';
  return `来源拒绝呈现整个结果集（${code}）`;
}

function rejectedReceipt({ input, descriptor, session, resultSetName, generation, preferredSyntax, operation, resultCount, discarded, pages }) {
  return {
    state: 'rejected',
    mode: 'structured',
    product: descriptor.product,
    source: descriptor.entry,
    query: typeof input.query === 'string' ? input.query : null,
    preferredSyntax,
    records: [],
    issues: [operationIssue(operation, { discardedRecords: discarded })],
    coverage: {
      structured: true,
      complete: false,
      state: 'result-set-invalid',
      session,
      resultSetName,
      generation,
      resultCount: resultCount ?? null,
      recordsReturned: discarded,
      recordsCollected: 0,
      pagesFetched: pages.length,
      reason: operation.code,
    },
    evidence: { sessionOpened: Boolean(session), resultSet: resultSetName ? { resultSetName, generation, resultCount } : null, pages },
  };
}

/**
 * Collect a complete catalogue result set.
 *
 * Each intake opens its own gateway session and searches once. Positions are
 * only meaningful inside (session, resultSetName, generation), so every record
 * carries that context and the whole set is discarded if the source reports
 * that context as gone instead of silently mixing pages from a re-search.
 */
export async function collectStructured({ input, descriptor, sourceBase, store }) {
  const pageSize = normalisePageSize(input.pageSize ?? input.count);
  const resultSetName = normaliseResultSetName(input.resultSetName);
  const preferredSyntax = typeof input.preferredSyntax === 'string' && input.preferredSyntax.trim()
    ? input.preferredSyntax.trim()
    : DEFAULT_SYNTAX;
  const query = typeof input.query === 'string' ? input.query : '';

  let session;
  try {
    session = await openSession(sourceBase);
  } catch (error) {
    return store.save(rejectedReceipt({
      input, descriptor, session: null, resultSetName, generation: null, preferredSyntax,
      operation: { code: error.code || 'open-failed', message: error.message, phase: error.phase || 'open', status: error.status ?? null, detail: error.detail ?? null },
      resultCount: null, discarded: 0, pages: [],
    }));
  }

  let search;
  try {
    search = await searchCatalogue(sourceBase, { session, resultSetName, query, replaceIndicator: true });
  } catch (error) {
    return store.save(rejectedReceipt({
      input, descriptor, session, resultSetName, generation: null, preferredSyntax,
      operation: { code: error.code || 'search-failed', message: error.message, phase: error.phase || 'search', status: error.status ?? null, detail: error.detail ?? null },
      resultCount: null, discarded: 0, pages: [],
    }));
  }

  const { generation, resultCount } = search;
  const records = [];
  const issues = [];
  const pages = [];
  let position = 1;
  let recordsReturned = 0;

  const recordIssueCount = () => issues.filter(issue => issue.scope === 'record').length;

  while (position <= resultCount && records.length + recordIssueCount() < MAX_RECORDS) {
    if (pages.length >= MAX_PAGES) {
      issues.push({
        scope: 'result-set', kind: 'incomplete', code: 'page-limit',
        message: '结果集分批领取超过页数上限，未能确认全部结果', position,
      });
      break;
    }

    let response;
    try {
      response = await presentCatalogue(sourceBase, {
        session, resultSetName, generation, start: position, count: pageSize, preferredSyntax,
      });
    } catch (error) {
      issues.push({
        scope: 'result-set', kind: 'incomplete', code: 'present-failed',
        message: `来源分批呈现请求失败：${error.message}`, position,
      });
      break;
    }
    if (!response.ok) {
      return store.save(rejectedReceipt({
        input, descriptor, session, resultSetName, generation, preferredSyntax,
        operation: response.operation,
        resultCount, discarded: records.length + recordIssueCount(), pages,
      }));
    }

    const page = response.body;
    const pageRecords = Array.isArray(page.records) ? page.records : null;
    const returned = page.numberOfRecordsReturned;
    if (!pageRecords || !Number.isInteger(returned) || returned !== pageRecords.length) {
      issues.push({
        scope: 'result-set', kind: 'incomplete', code: 'invalid-present-response',
        message: '来源分批呈现响应缺少一致的记录数量，无法确认本批内容', position,
      });
      break;
    }

    pages.push({ start: position, count: pageSize, returned, next: page.nextResultSetPosition ?? null });
    recordsReturned += returned;

    let positionMismatch = false;
    for (const [index, entry] of pageRecords.entries()) {
      const expected = position + index;
      const itemPosition = Number.isInteger(entry?.position) ? entry.position : expected;
      if (itemPosition !== expected) {
        issues.push({
          scope: 'result-set', kind: 'incomplete', code: 'position-mismatch',
          message: '来源返回的序号与请求批次不一致，不能确定记录对应的结果位置',
          expected, position: itemPosition,
        });
        positionMismatch = true;
        continue;
      }

      if (entry.retrievalRecord !== undefined && entry.retrievalRecord !== null) {
        try {
          const record = parseRetrievalRecord(entry.retrievalRecord);
          const body = typeof entry.retrievalRecord.body === 'string' ? Buffer.from(entry.retrievalRecord.body) : null;
          const evidence = body ? await store.blob(body) : null;
          records.push({
            ...record,
            position: itemPosition,
            resultSet: { session, name: resultSetName, generation },
            ...(evidence ? { evidence } : {}),
          });
        } catch (error) {
          issues.push({
            scope: 'record',
            kind: 'presentation',
            position: itemPosition,
            code: error.code || 'record-error',
            message: error.message,
            syntax: entry.retrievalRecord.syntax ?? null,
          });
        }
      } else if (entry.surrogateDiagnostic !== undefined && entry.surrogateDiagnostic !== null) {
        const diagnostic = entry.surrogateDiagnostic;
        issues.push({
          scope: 'record',
          kind: 'source-diagnostic',
          position: itemPosition,
          code: diagnostic.code ?? (diagnostic.condition !== undefined ? String(diagnostic.condition) : 'surrogate-diagnostic'),
          condition: diagnostic.condition ?? null,
          message: diagnostic.message || '来源明确拒绝呈现该条目',
          sourceDiagnostic: diagnostic,
        });
      } else {
        issues.push({
          scope: 'record', kind: 'presentation', position: itemPosition,
          code: 'unrecognised-entry', message: '来源返回了既非书目记录也非诊断的条目',
        });
      }
    }

    if (positionMismatch) break;

    if (returned === 0) {
      if (position <= resultCount) {
        issues.push({
          scope: 'result-set', kind: 'incomplete', code: 'short-result',
          message: '来源提前结束分批呈现，尚有结果未领取', position,
        });
      }
      break;
    }

    const next = page.nextResultSetPosition;
    if (!Number.isInteger(next) || next <= position) {
      issues.push({
        scope: 'result-set', kind: 'incomplete', code: 'cursor-not-advancing',
        message: '来源返回的下一位置无效，无法继续领取', position,
      });
      break;
    }
    position = next;
  }

  // Count everything the source accounted for, whether it became a record or a
  // per-item diagnostic; only then can coverage be considered complete.
  const accounted = records.length + recordIssueCount();
  if (position <= resultCount || accounted < resultCount) {
    if (!issues.some(issue => issue.scope === 'result-set')) {
      issues.push({
        scope: 'result-set', kind: 'incomplete', code: 'incomplete-coverage',
        message: '结果集未全部领取，不能视为完整', requested: resultCount, accounted,
      });
    }
  }

  const state = issues.length === 0 ? 'complete' : 'partial';

  return store.save({
    state,
    mode: 'structured',
    product: descriptor.product,
    source: descriptor.entry,
    query,
    preferredSyntax,
    records,
    issues,
    coverage: {
      structured: true,
      complete: state === 'complete',
      state,
      session,
      resultSetName,
      generation,
      resultCount,
      recordsReturned,
      recordsCollected: records.length,
      recordDiagnostics: recordIssueCount(),
      pagesFetched: pages.length,
      batchSize: pageSize,
      positions: resultCount > 0 ? { first: 1, last: resultCount, next: position } : { first: null, last: null, next: null },
    },
    evidence: {
      sessionOpened: true,
      resultSet: { resultSetName, generation, resultCount },
      pages,
    },
  });
}
