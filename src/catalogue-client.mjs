const DEFAULT_TIMEOUT = 5000;
const DEFAULT_LIMIT = 4 * 1024 * 1024;

async function postJson(baseUrl, path, payload, { timeout = DEFAULT_TIMEOUT, limit = DEFAULT_LIMIT } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
    redirect: 'error',
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > limit) throw new Error('来源响应超出收件限额');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { ok: response.ok, status: response.status, body };
}

function operationDiagnostic(response, phase) {
  return {
    code: response.body?.operationDiagnostic?.code || `http-${response.status}`,
    message: response.body?.operationDiagnostic?.message || response.body?.error || `来源在${phase}阶段返回 ${response.status}`,
    phase,
    status: response.status,
    detail: response.body?.operationDiagnostic || response.body || null,
  };
}

export async function openSession(sourceBase) {
  const response = await postJson(sourceBase, '/catalogue/open', {});
  if (!response.ok || typeof response.body?.session !== 'string') {
    throw Object.assign(new Error(operationDiagnostic(response, 'open').message), operationDiagnostic(response, 'open'));
  }
  return response.body.session;
}

export async function searchCatalogue(sourceBase, { session, resultSetName, query, replaceIndicator = true }) {
  const response = await postJson(sourceBase, '/catalogue/search', { session, resultSetName, query, replaceIndicator });
  if (!response.ok || response.body?.operationDiagnostic) {
    throw Object.assign(new Error(operationDiagnostic(response, 'search').message), operationDiagnostic(response, 'search'));
  }
  const { generation, resultCount } = response.body || {};
  if (!Number.isInteger(generation) || !Number.isInteger(resultCount) || resultCount < 0) {
    throw Object.assign(new Error('来源检索响应缺少有效结果集信息'), {
      code: 'invalid-search-response', message: '来源检索响应缺少有效结果集信息', phase: 'search', status: response.status, detail: response.body,
    });
  }
  return { generation, resultCount };
}

export async function presentCatalogue(sourceBase, { session, resultSetName, generation, start, count, preferredSyntax }) {
  const response = await postJson(sourceBase, '/catalogue/present', { session, resultSetName, generation, start, count, preferredSyntax });
  // A present response may be a successful page (including per-record diagnostics) or
  // an operationDiagnostic describing a result set that no longer exists.
  if (response.body?.operationDiagnostic) {
    return { ok: false, status: response.status, body: response.body, operation: operationDiagnostic(response, 'present') };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, body: response.body, operation: operationDiagnostic(response, 'present') };
  }
  return { ok: true, status: response.status, body: response.body || {} };
}
