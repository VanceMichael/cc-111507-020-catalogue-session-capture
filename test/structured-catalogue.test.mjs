import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
import { parseRetrievalRecord } from '../src/catalogue-records.mjs';

async function withService(scenario, run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-catalogue-'));
  const service = await createService({ dataDir, scenario });
  try { await run(service); } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
}

async function intake(service, body) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'structured', ...body }),
  });
  return { status: response.status, receipt: await response.json() };
}

test('结构化收件领取全部批次并区分逐记录诊断', async () => {
  await withService('standard', async service => {
    const { status, receipt } = await intake(service, { query: '港口 OR 航路', preferredSyntax: 'mods', pageSize: 1 });
    assert.equal(status, 201);
    assert.equal(receipt.state, 'partial');
    assert.equal(receipt.records.length, 2);
    assert.deepEqual(receipt.records.map(record => record.identity.value), ['b1', 'b3']);
    // The diagnostic item is reported as an issue, never as a bibliography record.
    assert.equal(receipt.issues.length, 1);
    assert.equal(receipt.issues[0].scope, 'record');
    assert.equal(receipt.issues[0].kind, 'source-diagnostic');
    assert.equal(receipt.issues[0].position, 2);
    assert.equal(receipt.issues[0].condition, 238);
    assert.ok(!JSON.stringify(receipt.records).includes('该条目不支持所选呈现格式'));

    assert.equal(receipt.coverage.resultCount, 3);
    assert.equal(receipt.coverage.recordsReturned, 3);
    assert.equal(receipt.coverage.recordsCollected, 2);
    assert.equal(receipt.coverage.recordDiagnostics, 1);
    assert.equal(receipt.coverage.pagesFetched, 3);
    assert.equal(receipt.coverage.complete, false);
    assert.equal(receipt.coverage.state, 'partial');
    for (const record of receipt.records) {
      assert.equal(record.resultSet.session, receipt.coverage.session);
      assert.equal(record.resultSet.name, receipt.coverage.resultSetName);
      assert.equal(record.resultSet.generation, receipt.coverage.generation);
      assert.ok(record.evidence.digest);
    }

    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.deepEqual(saved.records, receipt.records);
    assert.deepEqual(saved.issues, receipt.issues);
    assert.deepEqual(saved.coverage, receipt.coverage);

    const presents = service.gateway.trace.filter(item => item.path === '/catalogue/present');
    assert.equal(presents.length, 3);
  });
});

test('结果集被同名检索替换时整段失效，不保留旧页记录', async () => {
  await withService('replaced', async service => {
    const { status, receipt } = await intake(service, { query: '港口', pageSize: 1 });
    assert.equal(status, 201);
    assert.equal(receipt.state, 'rejected');
    assert.deepEqual(receipt.records, []);
    assert.equal(receipt.issues.length, 1);
    assert.equal(receipt.issues[0].scope, 'result-set');
    assert.equal(receipt.issues[0].kind, 'result-set-invalid');
    assert.equal(receipt.issues[0].code, 'set-replaced');
    assert.equal(receipt.coverage.state, 'result-set-invalid');
    assert.equal(receipt.coverage.complete, false);
    assert.equal(receipt.coverage.recordsCollected, 0);
    assert.ok(receipt.issues[0].discardedRecords >= 1);
  });
});

test('会话过期时整段结果集失效，不假装成部分成功', async () => {
  await withService('expired', async service => {
    const { receipt } = await intake(service, { query: '港口' });
    assert.equal(receipt.state, 'rejected');
    assert.deepEqual(receipt.records, []);
    assert.equal(receipt.issues[0].code, 'session-expired');
    assert.equal(receipt.issues[0].scope, 'result-set');
    assert.equal(receipt.coverage.complete, false);
  });
});

test('同时进行的采集使用各自会话，不互相覆盖结果集', async () => {
  await withService('concurrent', async service => {
    const [first, second] = await Promise.all([
      intake(service, { query: '港口', resultSetName: 'books', pageSize: 1 }),
      intake(service, { query: '航路', resultSetName: 'books', pageSize: 1 }),
    ]);
    for (const { status, receipt } of [first, second]) {
      assert.equal(status, 201);
      assert.equal(receipt.state, 'partial');
      assert.equal(receipt.records.length, 2);
      assert.equal(receipt.coverage.resultSetName, 'books');
      assert.equal(receipt.coverage.resultCount, 3);
    }
    assert.notEqual(first.receipt.coverage.session, second.receipt.coverage.session);
    for (const record of [...first.receipt.records, ...second.receipt.records]) {
      assert.equal(record.resultSet.name, 'books');
      assert.ok(record.resultSet.generation >= 1);
    }
    const saves = await (await fetch(`${service.baseUrl}/v1/receipts`)).json();
    assert.equal(saves.length, 2);
    assert.notEqual(saves[0].id, saves[1].id);
  });
});

test('每批都是后续呈现，不把首屏当作全部结果', async () => {
  await withService('standard', async service => {
    const { receipt } = await intake(service, { pageSize: 1 });
    assert.equal(receipt.evidence.pages.length, 3);
    assert.deepEqual(receipt.evidence.pages.map(page => page.start), [1, 2, 3]);
    assert.deepEqual(receipt.evidence.pages.map(page => page.next), [2, 3, 4]);
    const presents = service.gateway.trace.filter(item => item.path === '/catalogue/present');
    assert.equal(presents.length, 3);
  });
});

test('MARCXML 与 MODS 都按正文标识建立稳定身份', () => {
  const mods = parseRetrievalRecord({
    syntax: 'mods',
    body: '<mods xmlns="http://www.loc.gov/mods/v3"><titleInfo><title>港口史</title></titleInfo><name><namePart>李四</namePart></name><identifier type="local">b1</identifier></mods>',
  });
  assert.equal(mods.syntax, 'mods');
  assert.equal(mods.identity.value, 'b1');
  assert.equal(mods.title, '港口史');

  const marc = parseRetrievalRecord({
    syntax: 'MARCXML',
    body: '<collection xmlns="http://www.loc.gov/MARC21/slim"><record><leader>00000nam a2200000 a 4500</leader><controlfield tag="001">m1</controlfield><datafield tag="100" ind1="1" ind2=" "><subfield code="a">张三</subfield></datafield><datafield tag="245" ind1="1" ind2="0"><subfield code="a">航路记 /</subfield><subfield code="b">附注</subfield></datafield><datafield tag="260" ind1=" " ind2=" "><subfield code="a">北京 :</subfield><subfield code="b">某出版社,</subfield><subfield code="c">2020.</subfield></datafield></record></collection>',
  });
  assert.equal(marc.syntax, 'marcxml');
  assert.equal(marc.identity.value, 'm1');
  assert.equal(marc.title, '航路记 附注');
  assert.equal(marc.creators[0].name, '张三');
  assert.equal(marc.publisher, '某出版社,');
  assert.equal(marc.date, '2020');

  // A position is not an identity: records without a body identifier are rejected.
  assert.throws(() => parseRetrievalRecord({ syntax: 'mods', body: '<mods xmlns="http://www.loc.gov/mods/v3"><titleInfo><title>无标识</title></titleInfo></mods>' }), /稳定身份/);
  assert.throws(() => parseRetrievalRecord({ syntax: 'unknown', body: '<x/>' }), /不受支持/);
});
