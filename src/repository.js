import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class RecordRepository {
  constructor(path) { this.path = path; }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(value.records)) throw new Error('record file has no records array');
      return value.records;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async replace(records) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ records }, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}
