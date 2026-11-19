import { appendObservations, findRecords, projectRecords } from './records.js';
import { normalizeLinks } from './identity.js';

/**
 * Ingestion lifecycle.  Observations are append-only; the projected records
 * and the full history are written together so older consumers keep working.
 * Every collection run stamps one `receivedAt` on all pages of that batch, so
 * the handover view can reconstruct what was known at any moment.
 */
export class CollectionService {
  constructor(repository) { this.repository = repository; }

  async ingest(inputs, { receivedAt = new Date().toISOString() } = {}) {
    if (!Array.isArray(inputs)) throw new TypeError('ingest input must be an array');
    const state = await this.repository.readState();
    const observations = appendObservations(state.observations,
      inputs.map((record) => ({ ...record, receivedAt: record.receivedAt ?? receivedAt })));
    const records = projectRecords(observations);
    await this.repository.replaceState({ ...state, records, observations });
    // Keep the original return shape; history counts are exposed via history().
    return { accepted: inputs.length, stored: records.length };
  }

  /**
   * Record a reviewer-confirmed cross-source identity link.  This only writes
   * the decision; it does not merge or move any plan.
   */
  async recordIdentity(inputs) {
    const links = normalizeLinks(inputs);
    const state = await this.repository.readState();
    const identity = state.identity.slice();
    for (const link of links) {
      const index = identity.findIndex((current) =>
        current.source === link.source && current.sourceWindowId === link.sourceWindowId);
      if (index >= 0) identity[index] = link;
      else identity.push(link);
    }
    await this.repository.replaceState({ ...state, identity });
    return { recorded: links.length, identity: identity.length };
  }

  /** Current projected records, compatible with the original query contract. */
  async query(filters) { return findRecords(await this.repository.read(), filters); }

  async history() { return this.repository.readObservations(); }
}
