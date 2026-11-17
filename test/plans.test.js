import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { entryPath } from '../src/adapter.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { readOperations } from '../src/operations.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const portPath = entryPath;
const agentPath = '/agents/windows';

async function withCollector(run) {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'plans-'));
  try {
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository);
    const client = new SourceClient(source.url);
    await run({ source, repository, service, client });
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function findPlan(view, vesselId) {
  return view.plans.find((plan) => plan.vesselId === vesselId);
}

test('same vessel name alone never merges plans; same-berth overlap is flagged for review', async () => {
  await withCollector(async ({ service, client, repository }) => {
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
    await service.ingestPage(client, agentPath, { sourceKey: 'agent', receivedAt: '2026-11-16T10:01:00Z' });
    const view = await readOperations(repository);
    assert.equal(view.plans.length, 2, 'unknown agent window stays separate despite the shared name');
    const agentPlan = view.plans.find((plan) => plan.sources.includes('agent'));
    assert.equal(agentPlan.status, 'scheduled');
    assert.equal(agentPlan.identity.basis, 'unconfirmed');
    assert.ok(agentPlan.manualReview);
    assert.deepEqual(agentPlan.sameNamePlans, ['vessel:IMO-LOCAL-1']);
    assert.equal(view.conflicts.length, 1);
    assert.equal(view.conflicts[0].code, 'berth-overlap');
    assert.equal(view.conflicts[0].berth, 'B1');
    assert.ok(view.manualReview.some((item) => item.code === 'identity-unconfirmed'));
    assert.ok(view.manualReview.some((item) => item.code === 'berth-overlap'));
    // No automatic re-berthing: both source windows keep their own berth.
    assert.deepEqual(agentPlan.berths, ['B1']);
  });
});

test('a recorded identity decision links windows without moving berths or merging by name', async () => {
  await withCollector(async ({ service, client, repository }) => {
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
    await service.ingestPage(client, agentPath, { sourceKey: 'agent', receivedAt: '2026-11-16T10:01:00Z' });
    await service.recordIdentityDecisions([{
      sourceKey: 'agent', sourceWindowId: 'A7', vesselId: 'IMO-LOCAL-1', confirmedBy: 'dispatcher-local',
    }], { receivedAt: '2026-11-16T10:02:00Z' });
    const view = await readOperations(repository);
    assert.equal(view.plans.length, 1);
    const plan = findPlan(view, 'IMO-LOCAL-1');
    assert.equal(plan.identity.basis, 'vessel-id+decision');
    assert.deepEqual(plan.windows.map((window) => `${window.sourceKey}:${window.sourceWindowId}`).sort(),
      ['agent:A7', 'port:W1']);
    assert.deepEqual(plan.berths, ['B1']);
    assert.equal(view.conflicts.length, 0);
    assert.deepEqual(plan.manualReview, false);
    // The source window still reports no vesselId; the identity comes from the
    // recorded human decision, which stays visible as evidence.
    const agentWindow = plan.windows.find((window) => window.sourceKey === 'agent');
    assert.equal(agentWindow.vesselId, null);
    assert.equal(plan.identity.confirmations[0].confirmedBy, 'dispatcher-local');
    assert.equal(plan.identity.confirmations[0].decisionId, 'agent:A7:IMO-LOCAL-1');
  });
});

test('an explicit cancellation is surfaced with its source evidence, not as a silent removal', async () => {
  await withCollector(async ({ source, service, client, repository }) => {
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
    source.publish('updated');
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T11:00:00Z' });
    const view = await readOperations(repository);
    const plan = findPlan(view, 'IMO-LOCAL-1');
    assert.equal(plan.status, 'cancelled');
    assert.equal(plan.evidence.cancellation.sourceKey, 'port');
    assert.equal(plan.evidence.cancellation.sourceWindowId, 'W1');
    assert.equal(plan.evidence.cancellation.receivedAt, '2026-11-16T11:00:00Z');
    assert.deepEqual(plan.windows[0].history.map((version) => version.state), ['scheduled', 'cancelled']);
    const hidden = await readOperations(repository, { includeCancelled: false });
    assert.equal(hidden.plans.length, 0);
  });
});

test('a restoration clears the cancellation evidence and uses the restored window', async () => {
  await withCollector(async ({ source, service, client, repository }) => {
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
    source.publish('updated');
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:30:00Z' });
    source.publish('restored');
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T11:00:00Z' });
    const view = await readOperations(repository);
    const plan = findPlan(view, 'IMO-LOCAL-1');
    assert.equal(plan.status, 'restored');
    assert.equal(plan.effectiveStatus, 'active');
    assert.equal(plan.evidence.cancellation, null);
    assert.equal(plan.evidence.restoration.restoredAt, '2026-11-16T10:00:00Z');
    assert.deepEqual(plan.windows[0].history.map((version) => version.state), ['scheduled', 'cancelled', 'restored']);
  });
});

test('a temporary delay keeps the original window and reports the shifted times', async () => {
  await withCollector(async ({ source, service, client, repository }) => {
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
    source.publish('delayed');
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T11:00:00Z' });
    const view = await readOperations(repository);
    const plan = findPlan(view, 'IMO-LOCAL-1');
    assert.equal(plan.status, 'delayed');
    assert.equal(plan.windows[0].startsAt, '2026-11-17T03:00:00Z');
    assert.equal(plan.evidence.delay.previousStartsAt, '2026-11-17T00:00:00Z');
    assert.equal(plan.evidence.delay.startsAt, '2026-11-17T03:00:00Z');
    assert.equal(plan.evidence.delay.sourceWindowId, 'W1');
    // A delay is not a cancellation.
    assert.notEqual(plan.effectiveStatus, 'cancelled');
  });
});

test('a window cancelled by one source while another still schedules it is a review item, not a decision', async () => {
  await withCollector(async ({ source, service, client, repository }) => {
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
    await service.ingestPage(client, agentPath, { sourceKey: 'agent', receivedAt: '2026-11-16T10:01:00Z' });
    await service.recordIdentityDecisions([{
      sourceKey: 'agent', sourceWindowId: 'A7', vesselId: 'IMO-LOCAL-1', confirmedBy: 'dispatcher-local',
    }], { receivedAt: '2026-11-16T10:02:00Z' });
    source.publish('updated');
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T11:00:00Z' });
    const view = await readOperations(repository);
    const plan = findPlan(view, 'IMO-LOCAL-1');
    assert.equal(plan.status, 'disputed');
    assert.ok(plan.manualReview);
    assert.ok(plan.anomalies.some((item) => item.code === 'status-disagreement'));
    assert.equal(plan.windows.length, 2, 'both source windows remain visible');
    assert.equal(plan.windows.find((window) => window.sourceKey === 'port').berth, 'B2');
    assert.equal(plan.windows.find((window) => window.sourceKey === 'agent').berth, 'B1');
  });
});

test('as-of queries replay what had been received, not today\'s page', async () => {
  await withCollector(async ({ source, service, client, repository }) => {
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
    await service.ingestPage(client, agentPath, { sourceKey: 'agent', receivedAt: '2026-11-16T10:01:00Z' });
    await service.recordIdentityDecisions([{
      sourceKey: 'agent', sourceWindowId: 'A7', vesselId: 'IMO-LOCAL-1', confirmedBy: 'dispatcher-local',
    }], { receivedAt: '2026-11-16T10:02:00Z' });
    source.publish('updated');
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T11:00:00Z' });

    const before = await readOperations(repository, { asOf: '2026-11-16T10:30:00Z' });
    assert.equal(before.basis, 'received-by-asOf');
    const pastPlan = findPlan(before, 'IMO-LOCAL-1');
    assert.equal(pastPlan.status, 'scheduled');
    assert.equal(pastPlan.windows.find((window) => window.sourceKey === 'port').berth, 'B1');
    assert.equal(pastPlan.evidence.cancellation, null);

    const after = await readOperations(repository);
    assert.equal(findPlan(after, 'IMO-LOCAL-1').status, 'disputed');
  });
});

test('before an identity decision was received, the as-of view keeps the windows unmerged', async () => {
  await withCollector(async ({ service, client, repository }) => {
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
    await service.ingestPage(client, agentPath, { sourceKey: 'agent', receivedAt: '2026-11-16T10:01:00Z' });
    await service.recordIdentityDecisions([{
      sourceKey: 'agent', sourceWindowId: 'A7', vesselId: 'IMO-LOCAL-1', confirmedBy: 'dispatcher-local',
    }], { receivedAt: '2026-11-16T10:05:00Z' });
    const early = await readOperations(repository, { asOf: '2026-11-16T10:03:00Z' });
    assert.equal(early.plans.length, 2);
    assert.equal(early.conflicts.length, 1);
  });
});

test('a late page with an older modifiedAt cannot roll a window backwards', async () => {
  await withCollector(async ({ source, service, client, repository }) => {
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
    source.publish('updated');
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T11:00:00Z' });
    source.publish('opening');
    await service.ingestPage(client, portPath, { sourceKey: 'port', receivedAt: '2026-11-16T12:00:00Z' });
    const view = await readOperations(repository);
    const plan = findPlan(view, 'IMO-LOCAL-1');
    assert.equal(plan.status, 'cancelled');
    assert.equal(plan.windows[0].state, 'cancelled');
    assert.equal(plan.windows[0].berth, 'B2');
    // The late observation is still kept as evidence.
    assert.equal(plan.windows[0].history.length, 2);
  });
});

test('source windows from different sources are ordered by receipt, not source clocks', async () => {
  await withCollector(async ({ service, repository }) => {
    await service.ingest([
      { sourceId: 'X1', source: '港口窗口计划簿', sourceKey: 'port', observedAt: '2026-11-16T09:00:00Z', label: 'A',
        attributes: { sourceWindowId: 'X1', vesselId: 'IMO-X', vesselName: 'A', berth: 'B9',
          startsAt: '2026-11-18T00:00:00Z', endsAt: '2026-11-18T01:00:00Z', state: 'scheduled', modifiedAt: '2026-11-16T09:00:00Z' } },
    ], { receivedAt: '2026-11-16T10:00:00Z' });
    await service.ingest([
      { sourceId: 'X2', source: '港口窗口计划簿', sourceKey: 'agent', observedAt: '2026-11-14T09:00:00Z', label: 'A',
        attributes: { sourceWindowId: 'X2', vesselId: 'IMO-X', vesselName: 'A', berth: 'B9',
          startsAt: '2026-11-18T00:00:00Z', endsAt: '2026-11-18T01:00:00Z', state: 'scheduled', modifiedAt: '2026-11-14T09:00:00Z' } },
    ], { receivedAt: '2026-11-16T10:30:00Z' });
    const early = await readOperations(repository, { asOf: '2026-11-16T10:15:00Z' });
    assert.deepEqual(early.plans.map((plan) => plan.planId), ['vessel:IMO-X']);
    assert.equal(findPlan(early, 'IMO-X').windows.length, 1, 'the agent window had not been received yet');
    const late = await readOperations(repository);
    assert.equal(findPlan(late, 'IMO-X').windows.length, 2);
  });
});

test('an unmapped source state is reported for manual review instead of guessed', async () => {
  await withCollector(async ({ service, repository }) => {
    await service.ingest([
      { sourceId: 'Z1', source: '港口窗口计划簿', sourceKey: 'port', observedAt: '2026-11-16T09:00:00Z', label: 'Z',
        attributes: { sourceWindowId: 'Z1', vesselId: 'IMO-Z', vesselName: 'Z', berth: 'B8',
          startsAt: '2026-11-18T00:00:00Z', endsAt: '2026-11-18T01:00:00Z', state: 'unknown-state', modifiedAt: '2026-11-16T09:00:00Z' } },
    ], { receivedAt: '2026-11-16T10:00:00Z' });
    const view = await readOperations(repository);
    assert.equal(view.plans[0].status, 'unknown');
    assert.ok(view.manualReview.some((item) => item.code === 'state-unrecognized'));
  });
});
