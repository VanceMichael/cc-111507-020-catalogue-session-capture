import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('启动入口遵守 PORT 并在该端口提供健康检查', { timeout: 10000 }, async () => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const dataDir = await mkdtemp(join(tmpdir(), 'intake-port-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  try {
    const output = await new Promise((resolve, reject) => {
      let text = '';
      child.stdout.on('data', chunk => {
        text += chunk;
        if (text.includes('\n')) resolve(text.split('\n')[0]);
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`启动提前结束：${code}`)));
    });
    const announcement = JSON.parse(output);
    assert.equal(new URL(announcement.url).port, String(port));
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  } finally {
    child.kill('SIGTERM');
    await exit;
    await rm(dataDir, { recursive: true, force: true });
  }
});
