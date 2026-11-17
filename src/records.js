import { createHash } from 'node:crypto';
import { schema } from './schema.js';

function text(value) {
  return String(value ?? '').trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function sourceKeyOf(record) {
  return text(record?.sourceKey) || text(record?.attributes?.source) || text(record?.source);
}

export function recordKeyOf(record) {
  return `${sourceKeyOf(record)}:${text(record?.sourceId)}`;
}

export function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${schema.entity} must be an object`);
  }
  const attributes = input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes)
    ? structuredClone(input.attributes) : {};
  const record = {
    sourceId: text(input.sourceId),
    source: text(input.source),
    sourceKey: text(input.sourceKey) || text(attributes.source) || text(input.source),
    observedAt: text(input.observedAt),
    label: text(input.label),
    attributes,
  };
  for (const field of schema.required) {
    if (!record[field]) throw new Error(`missing ${field} for ${schema.entity}`);
  }
  if (!Number.isFinite(Date.parse(record.observedAt))) {
    throw new Error(`invalid observedAt for ${schema.entity}`);
  }
  const receivedAt = text(input.receivedAt);
  if (receivedAt) {
    if (!Number.isFinite(Date.parse(receivedAt))) {
      throw new Error(`invalid receivedAt for ${schema.entity}`);
    }
    record.receivedAt = receivedAt;
  }
  return record;
}

export function fingerprintRecord(record) {
  return createHash('sha256').update(stableStringify({
    sourceId: record.sourceId,
    source: record.source,
    sourceKey: record.sourceKey,
    observedAt: record.observedAt,
    label: record.label,
    attributes: record.attributes,
  })).digest('hex');
}

/**
 * A source observation is one distinct version of one source window.
 * `observedAt` is the source's own update time. `receivedAt` is when this
 * collector first saw that version, and is the only safe cross-source clock.
 */
export function observationFromRecord(input, { receivedAt, ingestId = null } = {}) {
  const record = normalizeRecord(input);
  const received = text(receivedAt) || record.receivedAt || new Date().toISOString();
  if (!Number.isFinite(Date.parse(received))) throw new Error(`invalid receivedAt for ${schema.entity}`);
  const fingerprint = fingerprintRecord(record);
  const key = recordKeyOf(record);
  return {
    observationId: `${key}::${record.observedAt}::${fingerprint.slice(0, 16)}`,
    recordKey: key,
    sourceKey: record.sourceKey,
    source: record.source,
    sourceId: record.sourceId,
    observedAt: record.observedAt,
    receivedAt: received,
    label: record.label,
    attributes: record.attributes,
    fingerprint,
    ingestId,
    firstSeenAt: received,
    lastSeenAt: received,
  };
}

export function recordsToObservations(records, { receivedAt } = {}) {
  return (Array.isArray(records) ? records : []).map((record) => observationFromRecord(record, {
    // Legacy records carry no receipt time; their source update time is the
    // only point at which they are known to have existed.
    receivedAt: record.receivedAt ?? receivedAt ?? record.observedAt,
    ingestId: null,
  }));
}

function compareVersion(left, right) {
  return Date.parse(left.observedAt) - Date.parse(right.observedAt)
    || Date.parse(left.receivedAt) - Date.parse(right.receivedAt)
    || left.observationId.localeCompare(right.observationId);
}

function compareRecordKey(left, right) {
  return left.recordKey.localeCompare(right.recordKey);
}

/**
 * Reconstruct the state known from information received by `asOf`.
 * Within one source window, source `modifiedAt` orders versions; a stale page
 * that arrives later therefore cannot roll the window backwards. Across
 * sources only receipt time is used, so two source clocks never compete.
 */
export function selectKnowledge(observations, { asOf, source, sourceKey } = {}) {
  const cutoff = asOf ? Date.parse(asOf) : Infinity;
  if (asOf && !Number.isFinite(cutoff)) throw new Error('invalid asOf');
  const selected = new Map();
  for (const observation of observations ?? []) {
    const received = Date.parse(observation.receivedAt);
    if (!Number.isFinite(received) || received > cutoff) continue;
    if (source && observation.source !== source && observation.sourceKey !== source) continue;
    if (sourceKey && observation.sourceKey !== sourceKey) continue;
    const current = selected.get(observation.recordKey);
    if (!current || compareVersion(observation, current) > 0) {
      selected.set(observation.recordKey, observation);
    }
  }
  return [...selected.values()].sort(compareRecordKey);
}

export function latestRecords(observations) {
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

export function mergeRecords(existing, incoming) {
  const merged = new Map(existing.map((record) => [recordKeyOf(record), record]));
  for (const record of incoming) {
    const key = recordKeyOf(record);
    const current = merged.get(key);
    if (!current || Date.parse(record.observedAt) >= Date.parse(current.observedAt)) {
      merged.set(key, record);
    }
  }
  return [...merged.values()].sort((left, right) => recordKeyOf(left).localeCompare(recordKeyOf(right)));
}

export function findRecords(records, { source, from, to } = {}) {
  return records.filter((record) => {
    if (source && record.source !== source && sourceKeyOf(record) !== source) return false;
    const timestamp = Date.parse(record.observedAt);
    if (from && timestamp < Date.parse(from)) return false;
    if (to && timestamp > Date.parse(to)) return false;
    return true;
  });
}
