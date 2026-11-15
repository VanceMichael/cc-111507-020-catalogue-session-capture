import { createHash } from 'node:crypto';
export async function receiveBytes(url, { headers = {}, limit = 16777216 } = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error(`来源返回 ${response.status}`);
  const parts = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > limit) throw new Error('来源超出收件限额');
    parts.push(chunk);
  }
  const bytes = Buffer.concat(parts);
  return { bytes, status: response.status, etag: response.headers.get('etag'), contentRange: response.headers.get('content-range'),
    digest: createHash('sha256').update(bytes).digest('hex') };
}
