import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeRecord } from './records.js';

/**
 * Persistent state: every observation ever received, the current projection
 * kept for older consumers, and reviewer-confirmed cross-source identity links.
 */
export class RecordRepository {
  constructor(path) { this.path = path; }

  async readState() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(value.records)) throw new Error('record file has no records array');
      const observations = Array.isArray(value.observations)
        ? value.observations.map((record) => normalizeRecord(record))
        : value.records.map((record) => normalizeRecord(record));
      return {
        records: value.records.map((record) => normalizeRecord(record)),
        observations,
        identity: Array.isArray(value.identity) ? value.identity : [],
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { records: [], observations: [], identity: [] };
      throw error;
    }
  }

  /** Current projection, retained for the existing records/query consumers. */
  async read() { return (await this.readState()).records; }

  async readObservations() { return (await this.readState()).observations; }

  async readIdentity() { return (await this.readState()).identity; }

  async replace(records) {
    const state = await this.readState();
    await this.replaceState({ ...state, records });
  }

  async replaceState({ records, observations, identity }) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const payload = { records, observations, identity: identity ?? [] };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}
