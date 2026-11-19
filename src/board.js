import { observationKey, rawSource, windowsAsOf } from './records.js';
import { resolveIdentity } from './identity.js';

/**
 * A source window only affects the board while the source's own latest
 * revision says so.  `cancelled` is an explicit withdrawal by that source;
 * `delayed` is a temporary postponement, not a cancellation.  An older
 * revision arriving late never resurrects or retires a newer one.
 */
export const activeStates = Object.freeze(['scheduled', 'delayed', 'restored']);
export const withdrawnStates = Object.freeze(['cancelled']);

export function windowStatus(record) {
  const state = String(record.attributes?.state ?? '').trim();
  const startsAt = String(record.attributes?.startsAt ?? '').trim();
  const endsAt = String(record.attributes?.endsAt ?? '').trim();
  const open = activeStates.includes(state);
  const closed = withdrawnStates.includes(state);
  return {
    state: state || 'unknown',
    active: open,
    withdrawn: closed,
    // Only listed windows can be conflict candidates; withdrawn rows are kept
    // for the audit trail but never block a berth.
    scheduled: open && Boolean(startsAt) && Boolean(endsAt)
      && Number.isFinite(Date.parse(startsAt)) && Number.isFinite(Date.parse(endsAt))
      && Date.parse(startsAt) < Date.parse(endsAt),
    temporary: state === 'delayed',
  };
}

function overlap(left, right) {
  const leftStart = Date.parse(left.attributes.startsAt);
  const leftEnd = Date.parse(left.attributes.endsAt);
  const rightStart = Date.parse(right.attributes.startsAt);
  const rightEnd = Date.parse(right.attributes.endsAt);
  if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)) return null;
  // Half-open [startsAt, endsAt): touching endpoints do not overlap.
  const start = Math.max(leftStart, rightStart);
  const end = Math.min(leftEnd, rightEnd);
  if (start >= end) return null;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
}

/** A short, explicit note for the duty screen; null when no explanation is needed. */
function statusNote(status) {
  if (status.withdrawn) return '来源已撤销该窗口';
  if (status.temporary) return '来源将窗口标记为暂时延迟，仍保留在值班计划中';
  return null;
}

function planIdentity(record, links) {
  const identity = resolveIdentity(record, links);
  return {
    status: identity.status,
    vesselId: identity.vesselId,
    planKey: identity.planKey,
    // sourceWindowId is only unique within a source.
    sourceWindowKey: `${rawSource(record)}/${record.attributes?.sourceWindowId ?? record.sourceId}`,
    basis: identity.basis,
    // Filled in once all rows exist: peers that are confirmed to be the same
    // plan.  They stay separate rows; this only makes the relationship visible.
    related: [],
  };
}

/**
 * Build the duty board.  Windows from different sources stay separate rows;
 * they are only linked when identity is confirmed.  Overlaps on the same berth
 * raise a review flag; nothing is moved, merged or dropped automatically.
 */
export function buildBoard(observations, { asOf, links = [] } = {}) {
  const windows = windowsAsOf(observations, asOf).map((record) => ({
    record,
    status: windowStatus(record),
    identity: planIdentity(record, links),
  }));

  const rows = windows.map(({ record, status, identity }) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    receivedAt: record.receivedAt,
    attributes: {
      sourceWindowId: record.attributes.sourceWindowId ?? record.sourceId,
      source: record.attributes.source ?? null,
      vesselId: record.attributes.vesselId ?? null,
      vesselName: record.attributes.vesselName ?? null,
      berth: record.attributes.berth ?? null,
      startsAt: record.attributes.startsAt ?? null,
      endsAt: record.attributes.endsAt ?? null,
      state: record.attributes.state ?? null,
      modifiedAt: record.attributes.modifiedAt ?? null,
    },
    state: status.state,
    note: statusNote(status),
    active: status.active,
    withdrawn: status.withdrawn,
    temporaryDelay: status.temporary,
    identity,
    review: [],
  }));

  const byWindow = new Map(windows.map((entry, index) => [observationKey(entry.record), rows[index]]));

  // Same berth, overlapping half-open intervals, both still listed.
  windows.forEach((left, index) => {
    windows.slice(index + 1).forEach((right) => {
      if (!left.status.scheduled || !right.status.scheduled) return;
      const berth = String(left.record.attributes.berth ?? '').trim();
      if (!berth || berth !== String(right.record.attributes.berth ?? '').trim()) return;
      const times = overlap(left.record, right.record);
      if (!times) return;
      const leftRow = byWindow.get(observationKey(left.record));
      const rightRow = byWindow.get(observationKey(right.record));
      const detail = { berth, ...times };
      leftRow.review.push({ type: 'berth-overlap', with: `${right.record.source}/${right.record.sourceId}`, ...detail });
      rightRow.review.push({ type: 'berth-overlap', with: `${left.record.source}/${left.record.sourceId}`, ...detail });
    });
  });

  for (const row of rows) {
    if (row.identity.status !== 'confirmed' && !row.withdrawn) {
      row.review.push({
        type: 'identity-unconfirmed',
        detail: '名称不能单独确认船舶身份，请人工核对 vesselId 或补充关联依据',
      });
    }
  }

  // The same confirmed vessel should not hold two live windows from one source
  // without a person looking at it.  We flag, never merge.
  const groups = new Map();
  for (const row of rows) {
    if (!row.identity.planKey || !row.active) continue;
    const key = `${row.attributes.source}\u0000${row.identity.planKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      row.review.push({
        type: 'multiple-windows',
        with: group.filter((other) => other !== row).map((other) => `${other.source}/${other.sourceId}`),
        detail: '同一来源的同一已确认船舶存在多个有效窗口，请人工确认保留哪一条',
      });
    }
  }

  // Cross-source peers with the same confirmed vessel id are listed, not
  // merged.  Identity comes from vesselId or a reviewed link, never a name.
  const plans = new Map();
  for (const row of rows) {
    if (!row.identity.planKey) continue;
    if (!plans.has(row.identity.planKey)) plans.set(row.identity.planKey, []);
    plans.get(row.identity.planKey).push(row);
  }
  for (const group of plans.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      row.identity.related = group
        .filter((other) => other !== row)
        .map((other) => ({
          source: other.source,
          sourceId: other.sourceId,
          sourceWindowKey: other.identity.sourceWindowKey,
          active: other.active,
          withdrawn: other.withdrawn,
        }));
    }
  }

  const reviews = rows
    .filter((row) => row.review.length)
    .map((row) => ({ source: row.source, sourceId: row.sourceId, issues: row.review }));

  return {
    product: '港口窗口计划簿',
    asOf: asOf ?? null,
    rows,
    reviews,
    // Explicitly state that this view never edits the source plan.
    actions: 'review-only',
  };
}
