import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
import { parseRetrievalRecord } from '../src/catalogue.mjs';

async function structuredIntake(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/intakes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, result: await response.json() };
}

async function withService(scenario, run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-check-'));
  const service = await createService({ dataDir, scenario });
  try {
    await run({ service, dataDir });
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('结构化收件：来源记录、可查询性及覆盖身份', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-check-'));
  const service = await createService({ dataDir });
  let receiptId;
  try {
    const { status, result } = await structuredIntake(service.baseUrl, { mode: 'structured', query: '港口 OR 航路', preferredSyntax: 'mods' });
    assert.equal(status, 201);
    assert.ok(['complete', 'partial'].includes(result.state));
    assert.ok(Array.isArray(result.records));
    assert.ok(Array.isArray(result.issues));
    assert.equal(result.records.length, 2);
    assert.ok(result.issues.length > 0);
    assert.equal(result.state, 'partial');
    // 分批领取真正取尽了结果集，而不是只看搜索首屏数量
    assert.equal(result.coverage.structured, true);
    assert.equal(result.coverage.exhausted, true);
    assert.equal(result.coverage.resultCount, 3);
    assert.equal(result.coverage.recordsCollected, 2);
    assert.deepEqual(result.records.map(record => record.id), ['b1', 'b3']);
    // 稳定身份来自正文标识，不是结果序号；来源定位仍可追溯
    assert.equal(result.records[0].identifiers[0].value, 'b1');
    assert.equal(result.records[0].source.position, 1);
    assert.equal(typeof result.records[0].source.resultSetName, 'string');
    // 诊断文字不混进书目，逐记录拒绝写入 issues
    assert.ok(result.records.every(record => record.syntax === 'mods' && record.title));
    const refusal = result.issues.find(issue => issue.scope === 'record');
    assert.ok(refusal);
    assert.equal(refusal.position, 2);
    assert.equal(refusal.code, 238);
    assert.match(refusal.message, /不支持所选呈现格式/);
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${result.id}`)).json();
    assert.deepEqual(saved.records, result.records);
    assert.deepEqual(saved.coverage, result.coverage);
    receiptId = result.id;
  } finally {
    await service.close();
  }
  // 新的实例打开相同 DATA_DIR 仍可查询既有结果
  const reopened = await createService({ dataDir });
  try {
    const again = await (await fetch(`${reopened.baseUrl}/v1/receipts/${receiptId}`)).json();
    assert.equal(again.id, receiptId);
    assert.deepEqual(again.records.map(record => record.id), ['b1', 'b3']);
  } finally {
    await reopened.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：同名检索替换结果集时不覆盖、不假装完成', async () => {
  await withService('replaced', async ({ service }) => {
    const { status, result } = await structuredIntake(service.baseUrl, { mode: 'structured', query: '港口', preferredSyntax: 'mods' });
    assert.equal(status, 201);
    // 结果集在领取途中被替换：有界重试后明确标记未取尽
    assert.equal(result.state, 'partial');
    assert.equal(result.coverage.exhausted, false);
    assert.ok(result.coverage.attempts > 1);
    const replaced = result.issues.find(issue => issue.scope === 'resultSet' && issue.code === 'set-replaced');
    assert.ok(replaced);
    // 已领取条目保留，已拒绝条目可定位，二者互不混淆
    assert.deepEqual(result.records.map(record => record.id), ['b1']);
    assert.ok(result.issues.some(issue => issue.scope === 'record' && issue.position === 2));
  });
});

test('结构化收件：会话过期后重新检索，仍失效则明确标记整段失效', async () => {
  await withService('expired', async ({ service }) => {
    const { status, result } = await structuredIntake(service.baseUrl, { mode: 'structured', query: '航路', preferredSyntax: 'mods' });
    assert.equal(status, 201);
    assert.equal(result.state, 'rejected');
    assert.deepEqual(result.records, []);
    assert.equal(result.coverage.exhausted, false);
    assert.ok(result.coverage.attempts > 1);
    const expired = result.issues.filter(issue => issue.scope === 'resultSet' && issue.code === 'session-expired');
    assert.ok(expired.length > 0);
    // 每次重试都重新开会话、重新检索，不复用旧序号
    assert.ok(result.evidence.sessions.length > 1);
    assert.equal(new Set(result.evidence.sessions).size, result.evidence.sessions.length);
  });
});

test('结构化收件：两个并发采集互不覆盖', async () => {
  await withService('concurrent', async ({ service }) => {
    const [first, second] = await Promise.all([
      structuredIntake(service.baseUrl, { mode: 'structured', query: '港口', preferredSyntax: 'mods' }),
      structuredIntake(service.baseUrl, { mode: 'structured', query: '航路', preferredSyntax: 'mods' }),
    ]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.result.state, 'partial');
    assert.equal(second.result.state, 'partial');
    assert.notEqual(first.result.id, second.result.id);
    assert.notEqual(first.result.coverage.resultSetName, second.result.coverage.resultSetName);
    assert.deepEqual(first.result.records.map(record => record.id), ['b1', 'b3']);
    assert.deepEqual(second.result.records.map(record => record.id), ['b1', 'b3']);
    const receipts = await (await fetch(`${service.baseUrl}/v1/receipts`)).json();
    assert.equal(receipts.length, 2);
    const opens = service.gateway.trace.filter(item => item.path === '/catalogue/open');
    assert.ok(opens.length >= 2);
  });
});

test('结构化收件：缺少检索式或著录格式不支持时返回中文错误', async () => {
  await withService('standard', async ({ service }) => {
    const noQuery = await structuredIntake(service.baseUrl, { mode: 'structured', preferredSyntax: 'mods' });
    assert.equal(noQuery.status, 400);
    assert.match(noQuery.result.error, /query/);
    const badSyntax = await structuredIntake(service.baseUrl, { mode: 'structured', query: '港口', preferredSyntax: 'unapi' });
    assert.equal(badSyntax.status, 400);
    assert.match(badSyntax.result.error, /著录格式/);
    const badBatch = await structuredIntake(service.baseUrl, { mode: 'structured', query: '港口', batchSize: 0 });
    assert.equal(badBatch.status, 400);
    assert.match(badBatch.result.error, /分批大小/);
  });
});

test('著录正文解析：MODS 与 MARCXML 的稳定身份取自正文标识', () => {
  const mods = parseRetrievalRecord({
    syntax: 'mods',
    body: '<mods xmlns="http://www.loc.gov/mods/v3"><titleInfo><title>港口史</title></titleInfo><identifier type="local">b1</identifier></mods>',
  });
  assert.equal(mods.supported, true);
  assert.equal(mods.id, 'b1');
  assert.equal(mods.title, '港口史');
  assert.deepEqual(mods.identifiers, [{ type: 'local', value: 'b1' }]);
  const marcxml = parseRetrievalRecord({
    syntax: 'marcxml',
    body: '<record xmlns="http://www.loc.gov/MARC21/slim"><leader>00000nam a2200000 a 4500</leader><controlfield tag="001">m9</controlfield><datafield tag="245" ind1="1" ind2="0"><subfield code="a">潮声集</subfield></datafield><datafield tag="020" ind1=" " ind2=" "><subfield code="a">9787000000000</subfield></datafield></record>',
  });
  assert.equal(marcxml.supported, true);
  assert.equal(marcxml.id, 'm9');
  assert.equal(marcxml.title, '潮声集');
  assert.ok(marcxml.identifiers.some(item => item.type === 'isbn' && item.value === '9787000000000'));
  const unsupported = parseRetrievalRecord({ syntax: 'unapi', body: '<x/>' });
  assert.equal(unsupported.supported, false);
  const noIdentifier = parseRetrievalRecord({
    syntax: 'mods',
    body: '<mods xmlns="http://www.loc.gov/mods/v3"><titleInfo><title>无标识</title></titleInfo></mods>',
  });
  assert.match(noIdentifier.id, /^sha256:[0-9a-f]{64}$/);
});
