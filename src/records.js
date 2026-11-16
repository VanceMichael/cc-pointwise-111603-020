import { schema } from './schema.js';

export function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${schema.entity} must be an object`);
  }
  const record = {
    sourceId: String(input.sourceId ?? '').trim(),
    source: String(input.source ?? '').trim(),
    observedAt: String(input.observedAt ?? '').trim(),
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
  return record;
}

export function mergeRecords(existing, incoming) {
  const merged = new Map(existing.map((record) => [record.sourceId, record]));
  for (const record of incoming) {
    const current = merged.get(record.sourceId);
    if (!current || Date.parse(record.observedAt) >= Date.parse(current.observedAt)) {
      merged.set(record.sourceId, record);
    }
  }
  return [...merged.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
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
