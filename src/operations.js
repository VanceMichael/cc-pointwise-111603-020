import { activeDecisions, buildPlanView, coverageOf, product } from './plans.js';
import { recordsToObservations, selectKnowledge } from './records.js';

const fields = ['sourceWindowId', 'source', 'vesselId', 'vesselName', 'berth', 'startsAt', 'endsAt', 'state', 'modifiedAt'];

// The original row view stays for existing consumers.
export async function readLegacyOperations(repository) {
  const records = await repository.read();
  return { product, rows: legacyRows(records) };
}

function legacyRows(records) {
  return records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  }));
}

/**
 * Operational read. At any observation point this answers "what did we know
 * then": restored, cancelled and temporarily delayed windows are expressed
 * from their own source evidence, and anything that cannot be resolved
 * automatically is returned as a manual-review item.
 */
export async function readOperations(repository, { asOf, includeCancelled = true } = {}) {
  const state = await repository.readState();
  const observations = state.observations.length
    ? state.observations
    : recordsToObservations(state.records);
  const decisions = activeDecisions(state.identityDecisions, asOf);
  const view = buildPlanView(observations, { asOf, decisions, includeCancelled });
  const plans = view.plans.map((plan) => ({
    planId: plan.planId,
    status: plan.status,
    effectiveStatus: plan.effectiveStatus,
    vesselId: plan.vesselId,
    vesselNames: plan.vesselNames,
    berths: plan.berths,
    startsAt: plan.startsAt,
    endsAt: plan.endsAt,
    sources: plan.sources,
    manualReview: plan.manualReview,
    identity: plan.identity,
    evidence: plan.evidence,
    sameNamePlans: plan.sameNamePlans ?? [],
    anomalies: plan.anomalies,
    windows: plan.windows,
  }));
  const cutoff = asOf == null ? Infinity : Date.parse(asOf);
  const knownRecords = state.observations.length
    ? selectKnowledge(state.observations, { asOf }).map((observation) => ({
      sourceId: observation.sourceId,
      source: observation.source,
      sourceKey: observation.sourceKey,
      observedAt: observation.observedAt,
      receivedAt: observation.receivedAt,
      label: observation.label,
      attributes: observation.attributes,
      recordKey: observation.recordKey,
    }))
    : state.records.filter((record) => Date.parse(record.receivedAt ?? record.observedAt) <= cutoff);
  return {
    product,
    // `rows` preserves the original per-source-window view; `plans` adds the
    // cross-source comparison, review items and conflicts.
    rows: legacyRows(knownRecords),
    asOf: view.asOf,
    basis: view.basis,
    plans,
    manualReview: view.manualReview,
    conflicts: view.conflicts,
    coverage: coverageOf(observations, { asOf }),
  };
}

export { buildPlanView, product };
