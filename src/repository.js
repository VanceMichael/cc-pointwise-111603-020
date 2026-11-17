import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { recordsToObservations, selectKnowledge, stableStringify } from './records.js';

function materialized(observations, fallbackRecords) {
  if (!observations.length) return fallbackRecords ?? [];
  return selectKnowledge(observations).map((observation) => ({
    sourceId: observation.sourceId,
    source: observation.source,
    sourceKey: observation.sourceKey,
    observedAt: observation.observedAt,
    receivedAt: observation.receivedAt,
    label: observation.label,
    attributes: structuredClone(observation.attributes),
    recordKey: observation.recordKey,
  }));
}

/**
 * Persists the complete collection state:
 * - records: materialized newest version of each source window (legacy view)
 * - observations: every source window version ever received, append-only
 * - ingests: batches that actually changed stored knowledge
 * - identityDecisions: explicit, reviewable cross-source plan links
 *
 * Files written by the earlier version (`{records: [...]}`) remain readable.
 */
export class RecordRepository {
  constructor(path) { this.path = path; }

  async readState() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!value || typeof value !== 'object' || !Array.isArray(value.records)) {
        throw new Error('record file has no records array');
      }
      return {
        records: value.records,
        observations: Array.isArray(value.observations) ? value.observations : [],
        ingests: Array.isArray(value.ingests) ? value.ingests : [],
        identityDecisions: Array.isArray(value.identityDecisions) ? value.identityDecisions : [],
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { records: [], observations: [], ingests: [], identityDecisions: [] };
      throw error;
    }
  }

  // Legacy view: the newest known version of each source window.
  async read() {
    const state = await this.readState();
    return materialized(state.observations, state.records);
  }

  async writeState({ records, observations, ingests, identityDecisions }) {
    const next = {
      records: Array.isArray(records) ? records : [],
      observations: Array.isArray(observations) ? observations : [],
      ingests: Array.isArray(ingests) ? ingests : [],
      identityDecisions: Array.isArray(identityDecisions) ? identityDecisions : [],
    };
    const body = `${JSON.stringify(next, null, 2)}\n`;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, body, { flag: 'wx' });
    await rename(temporary, this.path);
    return next;
  }

  async replace(records) {
    const state = await this.readState();
    return this.writeState({ ...state, records });
  }

  /**
   * Append source observations exactly once. A version seen again only moves
   * its lastSeenAt; it never rewrites the version or its receipt time.
   * Records are rematerialized in the same atomic write.
   *
   * Legacy files keep their newest-known records when migrated, so an older
   * page re-imported later cannot resurrect data that was already superseded.
   */
  async appendObservations(incoming, {
    receivedAt = new Date().toISOString(), ingestId = null, detail = null, identityDecisions,
  } = {}) {
    const state = await this.readState();
    const stored = [...state.observations];
    const knownIds = new Set(stored.map((observation) => observation.observationId));
    if (!stored.length && state.records.length) {
      const adopted = recordsToObservations(state.records);
      for (const observation of adopted) {
        if (knownIds.has(observation.observationId)) continue;
        knownIds.add(observation.observationId);
        stored.push({ ...observation, migrated: true });
      }
    }
    const byId = new Map(stored.map((observation) => [observation.observationId, observation]));
    let added = 0;
    for (const observation of incoming) {
      const existing = byId.get(observation.observationId);
      if (existing) {
        existing.lastSeenAt = [existing.lastSeenAt, observation.lastSeenAt ?? receivedAt]
          .filter(Boolean).sort().at(-1);
        continue;
      }
      byId.set(observation.observationId, {
        ...observation, ingestId, firstSeenAt: receivedAt, lastSeenAt: receivedAt,
      });
      added += 1;
    }
    const observations = [...byId.values()]
      .sort((left, right) => left.observationId.localeCompare(right.observationId));
    const before = stableStringify(selectKnowledge(stored.slice(0, state.observations.length)));
    const after = stableStringify(selectKnowledge(observations));
    const decisions = identityDecisions === undefined ? state.identityDecisions : identityDecisions;
    const changed = before !== after
      || stableStringify(decisions) !== stableStringify(state.identityDecisions);
    const ingests = changed && ingestId
      ? [...state.ingests, {
        ingestId, at: receivedAt, ...(detail ?? {}),
        observationsAdded: added, observationsReceived: incoming.length,
        observationsTotal: observations.length,
      }]
      : state.ingests;
    const next = await this.writeState({
      records: materialized(observations, state.records),
      observations, ingests, identityDecisions: decisions,
    });
    return { state: next, added, changed, ingested: Boolean(changed && ingestId) };
  }
}
