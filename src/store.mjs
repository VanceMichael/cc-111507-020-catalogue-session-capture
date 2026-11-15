import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class ReceiptStore {
  constructor(root = './var') { this.root = root; }
  async open() { await mkdir(join(this.root, 'blobs'), { recursive: true }); await mkdir(join(this.root, 'receipts'), { recursive: true }); }
  async blob(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(this.root, 'blobs', digest), bytes);
    return { digest, bytes: bytes.length };
  }
  async save(receipt) {
    const id = receipt.id || randomUUID();
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('收件标识无效');
    const result = { ...receipt, id };
    const temp = join(this.root, 'receipts', `${id}.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(result, null, 2));
    await rename(temp, join(this.root, 'receipts', `${id}.json`));
    return result;
  }
  async get(id) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
    try { return JSON.parse(await readFile(join(this.root, 'receipts', `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async list() {
    const names = (await readdir(join(this.root, 'receipts'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(names.map(name => this.get(name.slice(0, -5))));
  }
}
