import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { collect } from './receiver.mjs';
import { ReceiptStore } from './store.mjs';
import { createGateway } from './gateway.mjs';

export async function createService({ dataDir, scenario = 'standard' } = {}) {
  const store = new ReceiptStore(dataDir);
  await store.open();
  const gateway = await createGateway(scenario);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (url.pathname === '/health') return response.end(JSON.stringify({ status: 'ok' }));
      if (url.pathname === '/v1/source') return response.end(JSON.stringify(gateway.descriptor));
      if (url.pathname === '/v1/receipts' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/v1/receipts/') && request.method === 'GET') {
        const receipt = await store.get(url.pathname.split('/').at(-1));
        response.statusCode = receipt ? 200 : 404;
        return response.end(JSON.stringify(receipt || { error: '收件不存在' }));
      }
      if (url.pathname === '/v1/intakes' && request.method === 'POST') {
        const pieces = [];
        let size = 0;
        for await (const piece of request) {
          size += piece.length;
          if (size > 65536) throw new Error('请求体超过限制');
          pieces.push(piece);
        }
        const input = JSON.parse(Buffer.concat(pieces).toString());
        if (!['raw', 'structured'].includes(input.mode)) {
          response.statusCode = 400;
          return response.end(JSON.stringify({ error: '接收方式无效' }));
        }
        const result = await collect({ input, descriptor: gateway.descriptor, sourceBase: gateway.baseUrl, store });
        response.statusCode = result.httpStatus || 201;
        return response.end(JSON.stringify(result.receipt || result));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: '接口不存在' }));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, store, gateway, baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => { await new Promise(resolve => server.close(resolve)); await gateway.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const service = await createService({ dataDir: process.env.DATA_DIR || './var', scenario: process.env.SCENARIO || 'standard' });
  console.log(JSON.stringify({ message: '接收服务已启动', url: service.baseUrl, source: service.gateway.descriptor.product }));
  const stop = async () => { await service.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
