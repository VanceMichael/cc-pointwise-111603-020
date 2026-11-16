import { findRecords, mergeRecords, normalizeRecord } from './records.js';

export class CollectionService {
  constructor(repository) { this.repository = repository; }

  async ingest(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError('ingest input must be an array');
    const accepted = inputs.map(normalizeRecord);
    const current = await this.repository.read();
    const merged = mergeRecords(current, accepted);
    await this.repository.replace(merged);
    return { accepted: accepted.length, stored: merged.length };
  }

  async query(filters) { return findRecords(await this.repository.read(), filters); }
}
