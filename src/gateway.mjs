import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
const fixtures = new URL('../fixtures/', import.meta.url);
const definitions = JSON.parse(await readFile(new URL('scenarios.json', fixtures), 'utf8'));
const product = JSON.parse(await readFile(new URL('../product.json', import.meta.url), 'utf8'));

export async function createGateway(scenario = 'standard') {
  const spec = definitions.find(item => item.id === scenario);
  if (!spec) throw new Error('未知来源场景');
  const counts = {};
  const sessions = new Map();
  const trace = [];
  let generation = 1;
  const descriptor = { ...spec, product: product.name, kind: product.kind };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const query = Object.fromEntries(url.searchParams);
      counts[url.pathname] = (counts[url.pathname] || 0) + 1;
      trace.push({ method: request.method, path: url.pathname, query, range: request.headers.range || null, ifMatch: request.headers['if-match'] || null });
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      const send = (value, code = 200) => { response.statusCode = code; response.end(JSON.stringify(value)); };
      const file = async (name) => {
        if (!spec.resources.includes(name)) return send({ error: '资源未提供' }, 404);
        if ((scenario === 'missing-buffer' && name === 'metadata.bin') || (scenario === 'missing-content' && name.includes('payload/')) || (scenario === 'missing-alternative' && name === 'photo2.bin') || (scenario === 'missing-target' && name === 'target-release.json')) return send({ error: '来源资源缺失' }, 404);
        let bytes = await readFile(new URL(name, fixtures));
        if (scenario === 'bad-inventory-digest' && name.endsWith('.sha512')) bytes = Buffer.from('0'.repeat(128) + ' inventory.json\n');
        if (scenario === 'version-mismatch' && name === 'v2/inventory.json') bytes = Buffer.from(bytes.toString().replace('"head": "v2"', '"head": "v1"'));
        if (scenario === 'outside-offset' && name === 'metadata.bin') bytes = bytes.subarray(0, 3);
        const version = scenario === 'changed' && trace.length > 2 ? 'source-v2' : spec.version;
        const etag = `"${version}"`;
        response.setHeader('ETag', etag);
        response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Content-Type', 'application/octet-stream');
        if (request.headers['if-match'] && request.headers['if-match'] !== etag) { response.statusCode = 412; return response.end(); }
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
        if (match && scenario !== 'ignored-range') {
          const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
          if (start >= bytes.length || end < start) { response.statusCode = 416; return response.end(); }
          response.statusCode = 206;
          response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
          bytes = bytes.subarray(start, end + 1);
        }
        response.setHeader('Content-Length', bytes.length);
        for (let offset = 0; offset < bytes.length; offset += 7) response.write(bytes.subarray(offset, offset + 7));
        response.end();
      };
      if (url.pathname === '/manifest') return send(descriptor);
      if (url.pathname === '/trace') return send(trace.slice(0, -1));
      if (url.pathname.startsWith('/files/')) return file(decodeURIComponent(url.pathname.slice(7)));
      if (url.pathname.startsWith('/catalogue/') && request.method === 'POST') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks));
        if (url.pathname.endsWith('/open')) { const id = randomUUID(); sessions.set(id, new Map()); return send({ session: id }); }
        const sets = sessions.get(input.session);
        if (!sets) return send({ operationDiagnostic: { code: 'session-expired' } }, 410);
        if (url.pathname.endsWith('/search')) {
          if (sets.has(input.resultSetName) && !input.replaceIndicator) return send({ operationDiagnostic: { code: 'set-exists' } }, 409);
          generation += 1; sets.set(input.resultSetName, generation);
          return send({ resultSetName: input.resultSetName, generation, resultCount: 3 });
        }
        if (scenario === 'expired') { sessions.delete(input.session); return send({ operationDiagnostic: { code: 'session-expired' } }, 410); }
        if (scenario === 'replaced' && counts['/catalogue/present'] > 1) sets.set(input.resultSetName, generation + 1);
        if (sets.get(input.resultSetName) !== input.generation) return send({ operationDiagnostic: { code: 'set-replaced' } }, 409);
        const fixture = JSON.parse(await readFile(new URL('catalogue.json', fixtures), 'utf8'));
        const start = Number(input.start || 1), count = Number(input.count || 1);
        const records = fixture.records.slice(start - 1, start - 1 + count).map((record, index) => record.diagnostic ? { position: start + index, surrogateDiagnostic: record.diagnostic } : { position: start + index, retrievalRecord: record });
        return send({ numberOfRecordsReturned: records.length, nextResultSetPosition: start + records.length, records });
      }
      send({ error: '来源接口不存在' }, 404);
    } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { descriptor, trace, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
