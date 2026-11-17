import { createHash } from 'node:crypto';
import { normalizeRecord, observationFromRecord, recordsToObservations } from './records.js';
import { activeDecisions, buildPlanView, coverageOf, mergeIdentityDecisions, product } from './plans.js';
import { parsers, pageMeta } from './adapter.js';

function ingestIdFor(receivedAt, observations) {
  const seed = `${receivedAt}\n${observations.map((observation) => observation.observationId).sort().join('\n')}`;
  return `ing-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

function normalizeDecision(decision, receivedAt) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new TypeError('identity decision must be an object');
  }
  const vesselId = String(decision.vesselId ?? '').trim();
  const sourceWindowId = String(decision.sourceWindowId ?? '').trim();
  const source = String(decision.sourceKey ?? decision.source ?? '').trim();
  if (!vesselId) throw new Error('missing vesselId for identity decision');
  if (!sourceWindowId) throw new Error('missing sourceWindowId for identity decision');
  if (!source) throw new Error('missing source for identity decision');
  const decisionId = String(decision.decisionId ?? '').trim()
    || `${source}:${sourceWindowId}:${vesselId}`;
  return {
    decisionId, source, sourceWindowId, vesselId,
    confirmedBy: String(decision.confirmedBy ?? '').trim() || null,
    confirmedAt: String(decision.confirmedAt ?? '').trim() || null,
    note: String(decision.note ?? '').trim() || null,
    firstRecordedAt: receivedAt,
  };
}

export class CollectionService {
  constructor(repository) { this.repository = repository; }

  /**
   * Import one observed source page. `receivedAt` is this collector's clock;
   * `observedAt` on each record stays the source's own modification time.
   * Older pages can be imported after newer ones without rolling a window back.
   */
  async ingest(inputs, options = {}) {
    const result = await this.#ingest(inputs, options);
    // Keep the original return shape; page-level detail is available from
    // ingestPage() and from the stored ingest history.
    return { accepted: result.accepted, stored: result.stored };
  }

  async #ingest(inputs, options = {}) {
    if (!Array.isArray(inputs)) throw new TypeError('ingest input must be an array');
    const receivedAt = options.receivedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(receivedAt))) throw new Error('invalid receivedAt');
    const accepted = inputs.map((input) => normalizeRecord(input));
    const observations = accepted.map((record) => observationFromRecord(record, { receivedAt }));
    const ingestId = options.ingestId ?? ingestIdFor(receivedAt, observations);
    const decisions = Array.isArray(options.identityDecisions)
      ? mergeIdentityDecisions((await this.repository.readState()).identityDecisions,
        options.identityDecisions.map((decision) => normalizeDecision(decision, receivedAt)), { receivedAt })
      : undefined;
    const result = await this.repository.appendObservations(observations, {
      receivedAt, ingestId,
      detail: options.sourcePage ?? null,
      identityDecisions: decisions,
    });
    return {
      accepted: accepted.length,
      stored: result.state.records.length,
      observationsStored: result.state.observations.length,
      observationsAdded: result.added,
      changed: result.changed,
      ingested: result.ingested,
      ingestId: result.ingested ? ingestId : null,
      receivedAt,
    };
  }

  async ingestPage(sourceClient, path, { sourceKey, receivedAt = new Date().toISOString(), etag = null } = {}) {
    // Follow rel=next until the source is exhausted, then store the batch as
    // one received observation. A failed later page stores nothing.
    const parser = parsers[sourceKey] ?? parsers.port;
    const pages = [];
    const records = [];
    const seenPaths = new Set();
    let next = path;
    let pageEtag = etag;
    while (next) {
      if (seenPaths.has(next)) throw new Error(`source pagination cycle at ${next}`);
      if (pages.length >= 20) throw new Error('source pagination exceeds 20 pages');
      seenPaths.add(next);
      const response = await sourceClient.read(next, { etag: pageEtag });
      if (response.notModified) {
        return { notModified: true, accepted: 0, observationsAdded: 0, changed: false, ingested: false, receivedAt };
      }
      const page = parser(response);
      pages.push({ ...pageMeta(response, next), etag: response.etag ?? null, recordCount: page.records.length });
      records.push(...page.records);
      pageEtag = null;
      next = page.next;
    }
    const result = await this.#ingest(records, {
      receivedAt,
      sourcePage: {
        path, sourceKey: sourceKey ?? null, etag: pages[0]?.etag ?? null,
        digest: pages[0]?.digest ?? null, pages,
      },
    });
    return { ...result, notModified: false, next: null, records };
  }

  async recordIdentityDecisions(decisions, { receivedAt = new Date().toISOString() } = {}) {
    if (!Array.isArray(decisions)) throw new TypeError('identity decisions must be an array');
    const state = await this.repository.readState();
    const merged = mergeIdentityDecisions(state.identityDecisions,
      decisions.map((decision) => normalizeDecision(decision, receivedAt)), { receivedAt });
    await this.repository.appendObservations([], {
      receivedAt, ingestId: ingestIdFor(receivedAt, []), identityDecisions: merged,
      detail: { identityDecisionsReceived: decisions.length },
    });
    return { recorded: decisions.length, identityDecisions: merged.length };
  }

  async query(filters = {}) {
    const state = await this.repository.readState();
    if (filters.asOf !== undefined || filters.includeCancelled !== undefined
      || filters.coverage || filters.plans || filters.history) {
      return this.planQuery(filters, state);
    }
    return filterRecords(await this.repository.read(), filters);
  }

  planQuery(filters = {}, state) {
    const asOf = filters.asOf ?? undefined;
    const decisions = activeDecisions(state.identityDecisions, asOf);
    const observations = state.observations.length
      ? state.observations
      : recordsToObservations(state.records);
    const view = buildPlanView(observations, {
      asOf,
      decisions,
      includeCancelled: filters.includeCancelled !== false,
    });
    const result = {
      product,
      asOf: view.asOf,
      basis: view.basis,
      plans: view.plans,
      manualReview: view.manualReview,
      conflicts: view.conflicts,
    };
    if (filters.coverage) result.coverage = coverageOf(observations, { asOf, expectedSources: filters.expectedSources });
    if (filters.history) {
      result.history = state.ingests.map((entry) => ({
        ingestId: entry.ingestId, at: entry.at,
        observationsAdded: entry.observationsAdded ?? null,
        observationsTotal: entry.observationsTotal ?? null,
        sourcePage: entry.path ? { path: entry.path, sourceKey: entry.sourceKey ?? null, etag: entry.etag ?? null } : null,
      }));
    }
    return result;
  }
}

function filterRecords(rows, { source, from, to } = {}) {
  return rows.filter((record) => {
    if (source && record.source !== source && record.sourceKey !== source) return false;
    const timestamp = Date.parse(record.observedAt);
    if (from && timestamp < Date.parse(from)) return false;
    if (to && timestamp > Date.parse(to)) return false;
    return true;
  });
}
