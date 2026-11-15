import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
import { inspect } from '../src/source-metadata.mjs';
const scenarios = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url), 'utf8'));
for (const scenario of scenarios) {
  test(`原始资料收件与查询：${scenario.id}`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'intake-test-'));
    const service = await createService({ dataDir, scenario: scenario.id });
    try {
      assert.equal((await fetch(`${service.baseUrl}/health`)).status, 200);
      const response = await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'raw' }) });
      assert.equal(response.status, 201);
      const receipt = await response.json();
      assert.equal(receipt.state, 'received');
      assert.equal(receipt.coverage.structured, false);
      const bytes = await readFile(new URL(`../fixtures/${scenario.entry}`, import.meta.url));
      assert.equal(receipt.blobs[0].bytes, bytes.length);
      assert.equal(typeof receipt.metadata.format, 'string');
      const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
      assert.equal(saved.blobs[0].digest, receipt.blobs[0].digest);
      const files = await (await fetch(`${service.baseUrl}/v1/receipts`)).json();
      assert.equal(files.length, 1);
      const range = await fetch(`${service.gateway.baseUrl}/files/${encodeURIComponent(scenario.entry)}`, { headers: { range: 'bytes=0-7' } });
      assert.ok([200,206].includes(range.status));
      assert.equal((await fetch(`${service.gateway.baseUrl}/files/not-provided.bin`)).status, 404);
      assert.equal((await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST', body: '{' })).status, 400);
      assert.ok(service.gateway.trace.some(item => item.path.startsWith('/files/')));
    } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
  });
}
test('格式元信息不因头部短缺越界', () => {
  for (const bytes of [Buffer.alloc(0),Buffer.from([1]),Buffer.alloc(3)]) assert.doesNotThrow(() => inspect(bytes));
});
