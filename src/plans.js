import { stableStringify } from './records.js';
import { schema } from './schema.js';

export const product = schema.product;

export const HOLD_STATES = new Set(['delayed', 'delay', 'held', 'hold', 'postponed', 'suspended', 'temporarily-delayed', 'temporarily_delayed']);
export const CANCEL_STATES = new Set(['cancelled', 'canceled', 'cancel', 'withdrawn', 'revoked', 'deleted', 'removed']);
export const RESTORE_STATES = new Set(['restored', 'restore', 'reinstated', 'reopened', 'uncancelled', 'resumed', 'renewed']);
export const ACTIVE_STATES = new Set(['scheduled', 'active', 'confirmed', 'planned', 'expected']);

export function stateKind(state) {
  const value = String(state ?? '').trim().toLowerCase();
  if (HOLD_STATES.has(value)) return 'delayed';
  if (CANCEL_STATES.has(value)) return 'cancelled';
  if (RESTORE_STATES.has(value)) return 'restored';
  if (ACTIVE_STATES.has(value)) return 'active';
  return 'unknown';
}

function instant(value) {
  const parsed = Date.parse(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) { return String(value ?? '').trim() || null; }

function finiteWindow(window) {
  const start = instant(window.startsAt);
  const end = instant(window.endsAt);
  return start !== null && end !== null && end > start;
}

function overlaps(left, right) {
  return instant(left.startsAt) < instant(right.endsAt) && instant(right.startsAt) < instant(left.endsAt);
}

function planKeyForVessel(vesselId) { return `vessel:${vesselId}`; }

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function changedFields(previous, current) {
  if (!previous) return [];
  const fields = ['vesselId', 'vesselName', 'berth', 'startsAt', 'endsAt', 'state'];
  return fields.filter((field) => stableStringify(previous[field] ?? null) !== stableStringify(current[field] ?? null));
}

function versionView(observation) {
  return {
    observationId: observation.observationId,
    source: observation.source,
    sourceKey: observation.sourceKey,
    sourceId: observation.sourceId,
    vesselId: text(observation.attributes?.vesselId),
    vesselName: text(observation.attributes?.vesselName) ?? observation.label ?? null,
    berth: text(observation.attributes?.berth),
    startsAt: text(observation.attributes?.startsAt),
    endsAt: text(observation.attributes?.endsAt),
    state: text(observation.attributes?.state),
    modifiedAt: observation.observedAt,
    receivedAt: observation.receivedAt,
    observation: observation,
  };
}

/**
 * Build one window per (source, sourceWindowId) at the requested observation
 * point, keeping every version received by that point. Source `modifiedAt`
 * orders versions of the same window; stale pages that arrive late do not
 * move a window backwards.
 */
export function buildWindows(observations, { asOf } = {}) {
  const cutoff = asOf == null ? Infinity : instant(asOf);
  if (asOf != null && cutoff === null) throw new Error('invalid asOf');
  const versions = new Map();
  const seen = new Set();
  for (const observation of observations ?? []) {
    if (seen.has(observation.observationId)) continue;
    if (instant(observation.receivedAt) > cutoff) continue;
    seen.add(observation.observationId);
    if (!versions.has(observation.recordKey)) versions.set(observation.recordKey, []);
    versions.get(observation.recordKey).push(observation);
  }
  const windows = [];
  for (const [recordKey, list] of versions) {
    list.sort((left, right) => instant(left.observedAt) - instant(right.observedAt)
      || instant(left.receivedAt) - instant(right.receivedAt)
      || left.observationId.localeCompare(right.observationId));
    const history = [];
    for (const observation of list) {
      const view = versionView(observation);
      const previous = history.at(-1);
      view.changes = changedFields(previous, view);
      view.kind = stateKind(view.state);
      history.push(view);
    }
    const latest = history.at(-1);
    windows.push({
      recordKey,
      sourceKey: latest.sourceKey,
      source: latest.source,
      sourceId: latest.sourceId,
      vesselId: latest.vesselId,
      vesselName: latest.vesselName,
      berth: latest.berth,
      startsAt: latest.startsAt,
      endsAt: latest.endsAt,
      state: latest.state,
      kind: latest.kind,
      modifiedAt: latest.modifiedAt,
      receivedAt: latest.receivedAt,
      observationId: latest.observationId,
      firstReceivedAt: history[0].receivedAt,
      history,
      observations: list,
    });
  }
  return windows.sort((left, right) => left.recordKey.localeCompare(right.recordKey));
}

function resolveWindowIdentity(window, decisions, anomalies) {
  const identities = new Set();
  if (window.vesselId) identities.add(window.vesselId);
  const confirmations = [];
  for (const decision of decisions) {
    if (decision.source !== window.sourceKey || decision.sourceWindowId !== window.sourceId) continue;
    const vesselId = text(decision.vesselId);
    if (!vesselId) continue;
    if (window.vesselId && window.vesselId !== vesselId) {
      anomalies.push({
        code: 'identity-conflict',
        severity: 'warning',
        manual: true,
        message: `${window.source} window ${window.sourceId} declares vessel ${window.vesselId} but identity decision ${decision.decisionId} says ${vesselId}`,
        source: window.sourceKey,
        sourceWindowId: window.sourceId,
        expectedVesselId: window.vesselId,
        decidedVesselId: vesselId,
      });
      continue;
    }
    identities.add(vesselId);
    confirmations.push({
      vesselId,
      confirmedBy: decision.confirmedBy ?? null,
      confirmedAt: decision.confirmedAt ?? null,
      decisionId: decision.decisionId ?? null,
      note: decision.note ?? null,
    });
  }
  return { identities, confirmations };
}

/**
 * Group source windows into plans. Only a declared vesselId or a recorded
 * human identity decision can join two windows; a shared vessel name never
 * does. Unconfirmed windows stay separate and are flagged for review.
 */
export function groupPlans(windows, decisions = []) {
  const parent = new Map(windows.map((window) => [window.recordKey, window.recordKey]));
  const find = (key) => {
    let current = key;
    while (parent.get(current) !== current) current = parent.get(current);
    return current;
  };
  const union = (left, right) => {
    const a = find(left); const b = find(right);
    if (a !== b) parent.set(b, a);
  };
  const byIdentity = new Map();
  const planAnomalies = new Map(windows.map((window) => [window.recordKey, []]));
  const windowIdentity = new Map();
  for (const window of windows) {
    const anomalies = planAnomalies.get(window.recordKey);
    const { identities, confirmations } = resolveWindowIdentity(window, decisions, anomalies);
    windowIdentity.set(window.recordKey, { identities, confirmations });
    for (const identity of identities) {
      if (!byIdentity.has(identity)) byIdentity.set(identity, []);
      byIdentity.get(identity).push(window.recordKey);
    }
  }
  for (const members of byIdentity.values()) {
    for (const member of members.slice(1)) union(members[0], member);
  }
  const groups = new Map();
  for (const window of windows) {
    const root = find(window.recordKey);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(window);
  }
  const plans = [];
  for (const members of groups.values()) {
    members.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)
      || left.sourceId.localeCompare(right.sourceId));
    const identities = unique(members.flatMap((member) => [...windowIdentity.get(member.recordKey).identities]));
    const planId = identities.length === 1 ? planKeyForVessel(identities[0])
      : identities.length > 1 ? `window:${members.map((member) => member.recordKey).sort().join('|')}`
        : `window:${members[0].recordKey}`;
    const confirmations = members.flatMap((member) => windowIdentity.get(member.recordKey).confirmations);
    const anomalies = members.flatMap((member) => planAnomalies.get(member.recordKey));
    if (identities.length > 1) {
      anomalies.push({
        code: 'identity-conflict',
        severity: 'warning',
        manual: true,
        message: `windows in one plan claim different vessels: ${identities.join(', ')}`,
        vesselIds: identities,
      });
    }
    plans.push({ planId, vesselId: identities.length === 1 ? identities[0] : null, vesselIds: identities,
      windows: members, confirmations, anomalies });
  }
  return plans;
}

/**
 * Evidence for the transitions that are still in effect. Each source window's
 * history is read in source-update order, so a delayed window returning to
 * scheduled clears the delay, and a cancellation followed by a restoration
 * leaves the restoration in effect rather than the old cancellation.
 */
function transitionEvidence(window) {
  const history = window.history;
  let cancellation = null;
  let restoration = null;
  let delay = null;
  let previousNonDelayed = null;
  for (let index = 0; index < history.length; index += 1) {
    const version = history[index];
    const previous = index > 0 ? history[index - 1] : null;
    if (version.kind === 'cancelled' && previous?.kind !== 'cancelled') {
      cancellation = {
        kind: 'explicit', source: version.source, sourceKey: version.sourceKey,
        sourceWindowId: version.sourceId, observationId: version.observationId,
        previousState: previous?.state ?? null,
        cancelledAt: version.modifiedAt, receivedAt: version.receivedAt,
      };
      restoration = null;
    } else if (version.kind !== 'cancelled' && (previous?.kind === 'cancelled' || version.kind === 'restored')) {
      restoration = {
        kind: 'explicit', source: version.source, sourceKey: version.sourceKey,
        sourceWindowId: version.sourceId, observationId: version.observationId,
        restoredState: version.state, restoredAt: version.modifiedAt, receivedAt: version.receivedAt,
        startsAt: version.startsAt, endsAt: version.endsAt,
      };
      cancellation = null;
    }
    if (version.kind === 'delayed') {
      // The shift is against the last non-delayed window; subsequent delayed
      // versions that only move the times keep that original baseline.
      delay = {
        kind: 'explicit', source: version.source, sourceKey: version.sourceKey,
        sourceWindowId: version.sourceId, observationId: version.observationId,
        previousStartsAt: previousNonDelayed?.startsAt ?? null,
        startsAt: version.startsAt,
        previousEndsAt: previousNonDelayed?.endsAt ?? null,
        endsAt: version.endsAt,
        delayedAt: version.modifiedAt, receivedAt: version.receivedAt,
      };
    } else {
      delay = null;
      if (version.kind !== 'cancelled') previousNonDelayed = version;
    }
  }
  // Only transitions still in effect are current evidence; earlier ones stay
  // visible in the window history.
  if (history.at(-1)?.kind === 'cancelled') { restoration = null; delay = null; }
  else cancellation = null;
  return { cancellation, restoration, delay };
}

function windowAnomalies(window, confirmedIdentities = []) {
  const anomalies = [];
  if (!window.vesselId && !confirmedIdentities.length) {
    anomalies.push({
      code: 'identity-unconfirmed', severity: 'warning', manual: true,
      message: `${window.source} window ${window.sourceId} (${window.vesselName ?? 'unnamed'}) carries no vesselId; it was not merged with any other window`,
      source: window.sourceKey, sourceWindowId: window.sourceId, vesselName: window.vesselName,
    });
  }
  if (!finiteWindow(window)) {
    anomalies.push({
      code: 'invalid-window', severity: 'warning', manual: true,
      message: `${window.source} window ${window.sourceId} has an invalid or empty berth window`,
      source: window.sourceKey, sourceWindowId: window.sourceId,
      startsAt: window.startsAt, endsAt: window.endsAt,
    });
  }
  if (window.kind === 'unknown') {
    anomalies.push({
      code: 'state-unrecognized', severity: 'warning', manual: true,
      message: `${window.source} window ${window.sourceId} reports unrecognised state "${window.state}"`,
      source: window.sourceKey, sourceWindowId: window.sourceId, state: window.state,
    });
  }
  if (window.kind === 'restored' && !window.history.some((version) => version.kind === 'cancelled')) {
    anomalies.push({
      code: 'restoration-without-cancel', severity: 'warning', manual: true,
      message: `${window.source} window ${window.sourceId} is restored but no received cancellation precedes it`,
      source: window.sourceKey, sourceWindowId: window.sourceId,
    });
  }
  const vesselIds = unique(window.history.map((version) => version.vesselId));
  if (vesselIds.length > 1) {
    anomalies.push({
      code: 'vessel-id-changed', severity: 'warning', manual: true,
      message: `${window.source} window ${window.sourceId} changed vesselId over time: ${vesselIds.join(' -> ')}`,
      source: window.sourceKey, sourceWindowId: window.sourceId, vesselIds,
    });
  }
  return anomalies;
}

function planWindowsView(windows) {
  return windows.map((window) => {
    const evidence = transitionEvidence(window);
    return {
      source: window.source,
      sourceKey: window.sourceKey,
      sourceWindowId: window.sourceId,
      vesselId: window.vesselId,
      vesselName: window.vesselName,
      berth: window.berth,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      state: window.state,
      status: window.kind,
      modifiedAt: window.modifiedAt,
      receivedAt: window.receivedAt,
      firstReceivedAt: window.firstReceivedAt,
      observationId: window.observationId,
      history: window.history.map((version) => ({
        observationId: version.observationId,
        state: version.state,
        status: version.kind,
        vesselId: version.vesselId,
        vesselName: version.vesselName,
        berth: version.berth,
        startsAt: version.startsAt,
        endsAt: version.endsAt,
        modifiedAt: version.modifiedAt,
        receivedAt: version.receivedAt,
        changes: version.changes,
      })),
      evidence,
    };
  });
}

function deriveStatus(plan) {
  const live = plan.windows.filter((window) => window.kind !== 'cancelled');
  const kinds = new Set(plan.windows.map((window) => window.kind));
  if (live.length === 0 && plan.windows.length > 0) return { status: 'cancelled', effective: 'cancelled' };
  if (kinds.has('cancelled') && live.length > 0) return { status: 'disputed', effective: 'disputed' };
  if (kinds.has('unknown')) return { status: 'unknown', effective: 'unknown' };
  if (kinds.has('delayed')) return { status: 'delayed', effective: 'delayed' };
  if (kinds.has('restored')) return { status: 'restored', effective: 'active' };
  return { status: 'scheduled', effective: 'active' };
}

/**
 * Full plan view at an observation point. Every source window stays in the
 * plan with its own berth and times; disagreements become review items and
 * never cause a berth to be moved or two plans to be merged automatically.
 */
export function buildPlanView(observations, { asOf, decisions = [], includeCancelled = true } = {}) {
  const windows = buildWindows(observations, { asOf });
  const plans = groupPlans(windows, decisions);
  const manualReview = [];
  const conflicts = [];
  const views = [];
  for (const plan of plans) {
    const windowsView = planWindowsView(plan.windows);
    const confirmedIdentities = unique(plan.confirmations.map((confirmation) => confirmation.vesselId));
    const anomalies = [...plan.anomalies, ...plan.windows.flatMap((window) => windowAnomalies(window, confirmedIdentities))];
    const { status, effective } = deriveStatus(plan);
    const ownWindowKeys = new Set(plan.windows.map((window) => window.recordKey));
    const sourceKeys = unique(plan.windows.map((window) => window.sourceKey));
    const berths = unique(plan.windows.filter((window) => window.kind !== 'cancelled').map((window) => window.berth));
    const liveWindows = plan.windows.filter((window) => window.kind !== 'cancelled');
    const duplicateSources = [...new Set(liveWindows.map((window) => window.sourceKey))]
      .filter((key) => liveWindows.filter((window) => window.sourceKey === key).length > 1);
    if (sourceKeys.length > 1 && berths.length > 1) {
      anomalies.push({
        code: 'berth-disagreement', severity: 'info', manual: false,
        message: `sources report different berths for one vessel: ${berths.join(', ')}`,
        berths,
      });
    }
    if (status === 'disputed') {
      anomalies.push({
        code: 'status-disagreement', severity: 'warning', manual: true,
        message: 'one source explicitly cancels this plan while another still schedules it; both were kept',
        statuses: Object.fromEntries(plan.windows.map((window) => [window.sourceKey, window.kind])),
      });
    }
    if (duplicateSources.length) {
      anomalies.push({
        code: 'source-duplicate', severity: 'warning', manual: true,
        message: `one vessel has more than one live window from ${duplicateSources.join(', ')}`,
        sourceKeys: duplicateSources,
      });
    }
    const nameVariants = unique(plan.windows.map((window) => window.vesselName));
    const evidence = { cancellation: null, restoration: null, delay: null };
    // Prefer the evidence of the plan's current live windows over a window
    // that has since been cancelled.
    const evidenceOrder = [...windowsView].sort((left, right) => Number(left.status === 'cancelled')
      - Number(right.status === 'cancelled'));
    for (const window of evidenceOrder) {
      for (const key of Object.keys(evidence)) {
        if (!evidence[key] && window.evidence[key]) evidence[key] = window.evidence[key];
      }
    }
    const starts = plan.windows.map((window) => window.startsAt).filter(Boolean).sort();
    const ends = plan.windows.map((window) => window.endsAt).filter(Boolean).sort();
    const view = {
      planId: plan.planId,
      status,
      effectiveStatus: effective,
      vesselId: plan.vesselId,
      vesselIds: plan.vesselIds,
      vesselNames: nameVariants,
      berths,
      startsAt: starts[0] ?? null,
      endsAt: ends.at(-1) ?? null,
      sources: sourceKeys,
      windows: windowsView,
      identity: {
        basis: plan.vesselId
          ? (plan.confirmations.length ? 'vessel-id+decision' : 'vessel-id')
          : 'unconfirmed',
        vesselId: plan.vesselId,
        confirmations: plan.confirmations,
        conflicts: plan.vesselIds.filter((id) => id !== plan.vesselId),
      },
      evidence,
      anomalies,
      manualReview: anomalies.some((item) => item.manual),
      _windows: plan.windows,
      _ownWindowKeys: ownWindowKeys,
    };
    if (status === 'unknown') view.manualReview = true;
    views.push(view);
  }

  // Same-berth, same-time detection uses each source's own window, never a
  // merged berth. Half-open intervals: [startsAt, endsAt).
  for (let left = 0; left < views.length; left += 1) {
    for (let right = left + 1; right < views.length; right += 1) {
      const a = views[left]; const b = views[right];
      if (a.planId === b.planId) continue;
      for (const leftWindow of a._windows) {
        if (leftWindow.kind === 'cancelled' || !finiteWindow(leftWindow)) continue;
        for (const rightWindow of b._windows) {
          if (rightWindow.kind === 'cancelled' || !finiteWindow(rightWindow)) continue;
          if (leftWindow.berth !== rightWindow.berth) continue;
          if (!overlaps(leftWindow, rightWindow)) continue;
          const conflict = {
            code: 'berth-overlap',
            severity: 'warning',
            manual: true,
            berth: leftWindow.berth,
            startsAt: [leftWindow.startsAt, rightWindow.startsAt].sort()[0],
            endsAt: [leftWindow.endsAt, rightWindow.endsAt].sort().at(-1),
            window: { source: leftWindow.sourceKey, sourceWindowId: leftWindow.sourceId,
              vesselId: leftWindow.vesselId, startsAt: leftWindow.startsAt, endsAt: leftWindow.endsAt },
            other: { source: rightWindow.sourceKey, sourceWindowId: rightWindow.sourceId,
              vesselId: rightWindow.vesselId, startsAt: rightWindow.startsAt, endsAt: rightWindow.endsAt },
            plans: [a.planId, b.planId],
            message: `berth ${leftWindow.berth} is claimed by ${a.planId} and ${b.planId} in overlapping windows; berths were not changed and plans were not merged`,
          };
          conflicts.push(conflict);
          if (!a.anomalies.some((item) => item.code === 'berth-overlap' && item.otherPlanId === b.planId)) {
            a.anomalies.push({ ...conflict, otherPlanId: b.planId, planId: a.planId });
          }
          if (!b.anomalies.some((item) => item.code === 'berth-overlap' && item.otherPlanId === a.planId)) {
            b.anomalies.push({ ...conflict, otherPlanId: a.planId, planId: b.planId });
          }
        }
      }
    }
  }

  for (const plan of views) {
    plan.manualReview = plan.anomalies.some((item) => item.manual);
    for (const anomaly of plan.anomalies) {
      if (!anomaly.manual) continue;
      manualReview.push({ planId: plan.planId, ...anomaly });
    }
    delete plan._windows;
    delete plan._ownWindowKeys;
  }

  // A shared name is shown as a hint only; it is never treated as identity.
  const byName = new Map();
  for (const plan of views) {
    for (const name of unique(plan.windows.map((window) => window.vesselName))) {
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(plan.planId);
    }
  }
  for (const plan of views) {
    const others = unique(plan.windows.flatMap((window) => [...(byName.get(window.vesselName) ?? [])]))
      .filter((planId) => planId !== plan.planId);
    if (others.length) plan.sameNamePlans = others;
  }

  views.sort((left, right) => String(left.startsAt ?? '').localeCompare(String(right.startsAt ?? ''))
    || left.planId.localeCompare(right.planId));
  manualReview.sort((left, right) => String(left.planId).localeCompare(String(right.planId))
    || String(left.code).localeCompare(String(right.code))
    || String(left.berth ?? '').localeCompare(String(right.berth ?? '')));
  conflicts.sort((left, right) => String(left.berth ?? '').localeCompare(String(right.berth ?? ''))
    || String(left.plans[0]).localeCompare(String(right.plans[0])));
  const selected = includeCancelled ? views
    : views.filter((plan) => plan.effectiveStatus !== 'cancelled');
  return {
    asOf: asOf ?? null,
    basis: asOf ? 'received-by-asOf' : 'all-received',
    plans: selected,
    manualReview,
    conflicts,
    windows: windows.length,
  };
}

export function coverageOf(observations, { asOf, expectedSources = [] } = {}) {
  const cutoff = asOf == null ? Infinity : instant(asOf);
  if (asOf != null && cutoff === null) throw new Error('invalid asOf');
  const windows = buildWindows((observations ?? []).filter((observation) => instant(observation.receivedAt) <= cutoff), {});
  const keys = new Set([...expectedSources, ...windows.map((window) => window.sourceKey)]);
  return [...keys].sort().map((sourceKey) => {
    const relevant = windows.filter((window) => window.sourceKey === sourceKey);
    return {
      sourceKey,
      windows: relevant.length,
      lastReceivedAt: relevant.map((window) => window.receivedAt).sort().at(-1) ?? null,
      latestModifiedAt: relevant.map((window) => window.modifiedAt).sort().at(-1) ?? null,
      observed: relevant.length > 0,
    };
  });
}

export function identityDecisionKey(decision) {
  return `${text(decision.sourceKey ?? decision.source) ?? ''}:${text(decision.sourceWindowId) ?? ''}`;
}

/** Decisions are additive; a later decision supersedes an earlier one only explicitly. */
export function mergeIdentityDecisions(existing, incoming, { receivedAt = new Date().toISOString() } = {}) {
  const merged = new Map((existing ?? []).map((decision) => [decision.decisionId, decision]));
  for (const decision of incoming ?? []) {
    const normalized = {
      decisionId: decision.decisionId,
      source: text(decision.sourceKey ?? decision.source),
      sourceWindowId: text(decision.sourceWindowId),
      vesselId: text(decision.vesselId),
      confirmedBy: text(decision.confirmedBy),
      confirmedAt: text(decision.confirmedAt),
      note: text(decision.note),
      firstRecordedAt: decision.firstRecordedAt ?? receivedAt,
      lastConfirmedAt: receivedAt,
    };
    const previous = merged.get(normalized.decisionId);
    if (previous) normalized.firstRecordedAt = previous.firstRecordedAt;
    merged.set(normalized.decisionId, normalized);
  }
  return [...merged.values()].sort((left, right) => left.decisionId.localeCompare(right.decisionId));
}

export function decisionIsKnownAt(decision, asOf) {
  if (asOf == null) return true;
  const cutoff = instant(asOf);
  if (cutoff === null) throw new Error('invalid asOf');
  return instant(decision.firstRecordedAt ?? decision.confirmedAt) <= cutoff;
}

export function activeDecisions(decisions, asOf) {
  return (decisions ?? []).filter((decision) => decisionIsKnownAt(decision, asOf));
}
