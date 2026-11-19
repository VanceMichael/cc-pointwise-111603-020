import { createHash } from 'node:crypto';
import { schema } from './schema.js';

/**
 * A record is one observation of a source window.  `observedAt` is the source
 * revision time (modifiedAt); `receivedAt` is when this collector actually
 * received it.  Keeping both is what allows a handover view to be rebuilt from
 * what was known at that moment instead of from today's page.
 */
export function normalizeRecord(input, { receivedAt } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${schema.entity} must be an object`);
  }
  const observedAt = String(input.observedAt ?? '').trim();
  const record = {
    sourceId: String(input.sourceId ?? '').trim(),
    source: String(input.source ?? '').trim(),
    observedAt,
    // Structured/local imports predate reception metadata.  Falling back to
    // observedAt keeps those imports deterministic; live collection always
    // supplies an explicit receivedAt.
    receivedAt: String(input.receivedAt ?? receivedAt ?? observedAt).trim(),
    label: String(input.label ?? '').trim(),
    attributes: input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes)
      ? structuredClone(input.attributes) : {},
  };
  for (const field of schema.required) {
    if (!record[field]) throw new Error(`missing ${field} for ${schema.entity}`);
  }
  if (!Number.isFinite(Date.parse(record.observedAt))) {
    throw new Error(`invalid observedAt for ${schema.entity}`);
  }
  if (!Number.isFinite(Date.parse(record.receivedAt))) {
    throw new Error(`invalid receivedAt for ${schema.entity}`);
  }
  return record;
}

/** sourceWindowId is only unique inside one source, so the key is composite. */
export function observationKey(record) {
  return `${rawSource(record)}\u0000${record.sourceId}`;
}

/** The source's own identifier, not the display label. */
export function rawSource(record) {
  return String(record.attributes?.source ?? record.source);
}

export function windowRef(record) {
  return {
    source: record.source,
    sourceId: record.sourceId,
    sourceWindowId: String(record.attributes?.sourceWindowId ?? record.sourceId),
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Content fingerprint used only to make replayed observations idempotent. */
export function fingerprintRecord(record) {
  return createHash('sha256').update(stableStringify({
    rawSource: rawSource(record),
    sourceId: record.sourceId,
    observedAt: record.observedAt,
    label: record.label,
    attributes: record.attributes,
  })).digest('hex');
}

export function appendObservations(existing, incoming) {
  const known = new Set(existing.map((record) => fingerprintRecord(record)));
  const observations = existing.slice();
  for (const input of incoming) {
    const record = normalizeRecord(input);
    const fingerprint = fingerprintRecord(record);
    if (known.has(fingerprint)) continue;
    known.add(fingerprint);
    observations.push(record);
  }
  return observations;
}

function newer(left, right) {
  const sourceTime = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  if (sourceTime !== 0) return sourceTime;
  const receivedTime = Date.parse(left.receivedAt) - Date.parse(right.receivedAt);
  if (receivedTime !== 0) return receivedTime;
  return 0;
}

/**
 * Pick the latest source revision of every window from observations received
 * no later than `asOf`.  A later receipt of an older source revision does not
 * overwrite a newer one.
 */
export function windowsAsOf(observations, asOf) {
  const cutoff = asOf === undefined || asOf === null || asOf === ''
    ? null : Date.parse(asOf);
  if (cutoff !== null && !Number.isFinite(cutoff)) throw new Error('invalid asOf');
  const latest = new Map();
  observations.forEach((input, index) => {
    const record = normalizeRecord(input);
    if (cutoff !== null && Date.parse(record.receivedAt) > cutoff) return;
    const key = observationKey(record);
    const current = latest.get(key);
    if (!current || newer(record, current.record) >= 0) latest.set(key, { record, index });
  });
  return [...latest.values()]
    .map(({ record }) => record)
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId)
      || left.source.localeCompare(right.source));
}

/** Current projection, kept for the existing records/query consumers. */
export function projectRecords(observations) {
  return windowsAsOf(observations);
}

export function mergeRecords(existing, incoming) {
  const observations = appendObservations(existing, incoming);
  return projectRecords(observations);
}

export function findRecords(records, { source, from, to } = {}) {
  return records.filter((record) => {
    if (source && record.source !== source) return false;
    const timestamp = Date.parse(record.observedAt);
    if (from && timestamp < Date.parse(from)) return false;
    if (to && timestamp > Date.parse(to)) return false;
    return true;
  });
}
