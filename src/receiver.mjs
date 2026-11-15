import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
export async function collect({ input, descriptor, sourceBase, store }) {
  if (input.mode !== 'raw') return { httpStatus: 501, error: '当前仅开放原始资料接收' };
  const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
  const blob = await store.blob(source.bytes);
  const receipt = await store.save({ state: 'received', mode: 'raw', product: descriptor.product,
    source: descriptor.entry, sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
    records: [], issues: [], coverage: { structured: false, downloadedBytes: source.bytes.length } });
  return { receipt };
}
