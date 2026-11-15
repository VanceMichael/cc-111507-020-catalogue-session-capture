import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
test('结构化收件：来源记录、可查询性及覆盖身份', { skip: process.env.STRUCTURED !== '1' ? '结构化方式尚未开放；启用 STRUCTURED=1 检查' : false }, async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'structured-check-'));
  const service=await createService({dataDir});
  try {
    const response=await fetch(`${service.baseUrl}/v1/intakes`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({"mode": "structured", "query": "港口 OR 航路", "preferredSyntax": "mods"})});
    assert.equal(response.status,201);
    const result=await response.json();
    assert.ok(['complete','partial'].includes(result.state));
    assert.ok(Array.isArray(result.records));
    assert.ok(Array.isArray(result.issues));
    assert.equal(result.records.length, 2); assert.ok(result.issues.length > 0); assert.equal(result.state, 'partial');
    const saved=await (await fetch(`${service.baseUrl}/v1/receipts/${result.id}`)).json();
    assert.deepEqual(saved.records,result.records);
    assert.deepEqual(saved.coverage,result.coverage);
  } finally {await service.close();await rm(dataDir,{recursive:true,force:true});}
});
