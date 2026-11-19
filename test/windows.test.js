import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendObservations, windowsAsOf } from '../src/records.js';
import { buildBoard } from '../src/board.js';
import { resolveIdentity } from '../src/identity.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { readOperations } from '../src/operations.js';

const window = (overrides = {}) => ({
  sourceId: 'W1',
  source: '港口窗口计划簿',
  observedAt: '2026-11-16T08:00:00Z',
  label: 'Local Dawn',
  attributes: {
    source: 'port',
    sourceWindowId: 'W1',
    vesselId: 'IMO-1',
    vesselName: 'Local Dawn',
    berth: 'B1',
    startsAt: '2026-11-17T00:00:00Z',
    endsAt: '2026-11-17T02:00:00Z',
    state: 'scheduled',
    ...overrides.attributes,
  },
  ...overrides,
});

const agent = (overrides = {}) => window({
  sourceId: 'A7',
  source: '代理靠泊计划',
  attributes: {
    source: 'agent',
    sourceWindowId: 'A7',
    vesselId: null,
    vesselName: 'Local Dawn',
    berth: 'B1',
    startsAt: '2026-11-17T01:00:00Z',
    endsAt: '2026-11-17T03:00:00Z',
    state: 'scheduled',
  },
  ...overrides,
});

test('same sourceWindowId from two sources stays two observations', () => {
  const observations = appendObservations([], [
    window(),
    window({ source: '代理靠泊计划', attributes: { ...window().attributes, source: 'agent' } }),
  ]);
  assert.equal(observations.length, 2);
  assert.equal(windowsAsOf(observations).length, 2);
});

test('from the same source the newest source revision wins even when received first', () => {
  const observations = appendObservations([], [
    window({ observedAt: '2026-11-16T09:00:00Z', receivedAt: '2026-11-16T09:05:00Z', attributes: { ...window().attributes, state: 'cancelled' } }),
    // A late replay of an older page must not resurrect the window.
    window({ observedAt: '2026-11-16T08:00:00Z', receivedAt: '2026-11-16T12:00:00Z' }),
  ]);
  assert.equal(windowsAsOf(observations)[0].attributes.state, 'cancelled');
});

test('handover projection only uses observations received by that moment', () => {
  const observations = appendObservations([], [
    window({ receivedAt: '2026-11-16T08:05:00Z' }),
    window({
      observedAt: '2026-11-16T09:00:00Z',
      receivedAt: '2026-11-16T09:05:00Z',
      attributes: { ...window().attributes, state: 'cancelled', vesselName: 'Local Dawn II' },
    }),
  ]);
  const earlier = windowsAsOf(observations, '2026-11-16T08:30:00Z');
  assert.equal(earlier[0].attributes.state, 'scheduled');
  assert.equal(earlier[0].attributes.vesselName, 'Local Dawn');
  // A delayed source arriving later is not retroactively known.
  assert.equal(windowsAsOf(observations, '2026-11-16T09:04:00Z').length, 1);
  assert.equal(windowsAsOf(observations, '2026-11-16T09:06:00Z')[0].attributes.state, 'cancelled');
});

test('a delayed window remains listed but marks the temporary postponement', () => {
  const board = buildBoard(appendObservations([], [window({
    attributes: { ...window().attributes, state: 'delayed' },
  })]));
  assert.equal(board.rows[0].active, true);
  assert.equal(board.rows[0].withdrawn, false);
  assert.equal(board.rows[0].temporaryDelay, true);
  assert.equal(board.rows[0].state, 'delayed');
});

test('cancelled and restored are separate source revisions in history', () => {
  const observations = appendObservations([], [
    window(),
    window({ observedAt: '2026-11-16T09:00:00Z', attributes: { ...window().attributes, state: 'cancelled' } }),
    window({ observedAt: '2026-11-16T10:00:00Z', attributes: { ...window().attributes, state: 'scheduled' } }),
  ]);
  assert.equal(observations.length, 3, '每次来源修订都保留');
  assert.equal(windowsAsOf(observations)[0].attributes.state, 'scheduled');
  const cancelled = appendObservations([], observations.slice(0, 2));
  assert.equal(buildBoard(cancelled).rows[0].withdrawn, true);
});

test('a name change does not break source-declared identity, and a name alone cannot confirm it', () => {
  const renamed = window({ attributes: { ...window().attributes, vesselName: 'Local Dawn II', berth: 'B2' } });
  assert.equal(resolveIdentity(renamed).status, 'confirmed');
  assert.equal(resolveIdentity(renamed).vesselId, 'IMO-1');

  const unnamedAgent = agent();
  const identity = resolveIdentity(unnamedAgent);
  assert.equal(identity.status, 'unconfirmed', '同名不能单独合并');
  assert.equal(identity.planKey, null);
  assert.equal(identity.basis.type, 'name-only');

  const linked = resolveIdentity(unnamedAgent, [
    { source: 'agent', sourceWindowId: 'A7', vesselId: 'IMO-1', confirmedBy: 'dispatcher-local' },
  ]);
  assert.equal(linked.status, 'confirmed', '人工复核关联可确认身份');
  assert.equal(linked.vesselId, 'IMO-1');
});

test('same berth overlap is flagged for review and never merged', () => {
  const board = buildBoard(appendObservations([], [window(), agent()]));
  assert.equal(board.actions, 'review-only');
  assert.equal(board.rows.length, 2, '不自动合并两个来源的窗口');
  for (const row of board.rows) {
    assert.deepEqual(row.review.find((issue) => issue.type === 'berth-overlap'), {
      type: 'berth-overlap',
      with: row.source === '港口窗口计划簿' ? '代理靠泊计划/A7' : '港口窗口计划簿/W1',
      berth: 'B1',
      startsAt: '2026-11-17T01:00:00.000Z',
      endsAt: '2026-11-17T02:00:00.000Z',
    });
  }
});

test('touching half-open windows do not overlap, and cancelled windows do not block a berth', () => {
  const touching = window({
    sourceId: 'W2',
    attributes: { ...window().attributes, sourceWindowId: 'W2', vesselId: 'IMO-2', startsAt: '2026-11-17T02:00:00Z', endsAt: '2026-11-17T03:00:00Z' },
  });
  assert.equal(buildBoard(appendObservations([], [window(), touching])).reviews.length, 0);

  const cancelled = window({
    sourceId: 'W3',
    attributes: { ...window().attributes, sourceWindowId: 'W3', vesselId: 'IMO-3', state: 'cancelled' },
  });
  assert.equal(buildBoard(appendObservations([], [window(), cancelled])).reviews.length, 0);
});

test('unconfirmed identity is raised for manual review even without an overlap', () => {
  const board = buildBoard(appendObservations([], [agent()]));
  assert.deepEqual(board.reviews.map((entry) => entry.issues.map((issue) => issue.type)), [['identity-unconfirmed']]);
});

test('cancelled and delayed rows carry an explicit note for the duty screen', () => {
  const cancelled = buildBoard(appendObservations([], [window({
    attributes: { ...window().attributes, state: 'cancelled' },
  })])).rows[0];
  assert.match(cancelled.note, /撤销/);

  const delayed = buildBoard(appendObservations([], [window({
    attributes: { ...window().attributes, state: 'delayed' },
  })])).rows[0];
  assert.match(delayed.note, /暂时延迟/);
  assert.equal(delayed.temporaryDelay, true);
  assert.equal(delayed.active, true, '暂时延迟不等于取消');
});

test('a restored source revision re-activates the same window', () => {
  const observations = appendObservations([], [
    window(),
    window({ observedAt: '2026-11-16T09:00:00Z', attributes: { ...window().attributes, state: 'cancelled' } }),
    window({ observedAt: '2026-11-16T10:00:00Z', attributes: { ...window().attributes, state: 'scheduled', startsAt: '2026-11-17T04:00:00Z', endsAt: '2026-11-17T06:00:00Z' } }),
  ]);
  const row = buildBoard(observations).rows[0];
  assert.equal(row.active, true);
  assert.equal(row.withdrawn, false);
  assert.equal(row.attributes.startsAt, '2026-11-17T04:00:00Z');
  // The cancelled and restored revisions remain available for audit.
  assert.deepEqual(windowsAsOf(observations, '2026-11-16T09:30:00Z').map((record) => record.attributes.state), ['cancelled']);
});

test('operations rebuilds a past handover from persisted observations, not today’s page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'board-'));
  try {
    const repository = new RecordRepository(join(directory, 'state.json'));
    const service = new CollectionService(repository);
    await service.ingest([window()], { receivedAt: '2026-11-16T08:05:00Z' });
    await service.ingest([window({
      observedAt: '2026-11-16T09:00:00Z',
      attributes: { ...window().attributes, state: 'cancelled', berth: 'B2' },
    })], { receivedAt: '2026-11-16T09:05:00Z' });

    const current = await readOperations(repository);
    assert.equal(current.rows[0].withdrawn, true);
    assert.equal(current.rows[0].attributes.berth, 'B2');

    const handover = await readOperations(repository, { asOf: '2026-11-16T08:30:00Z' });
    assert.equal(handover.rows.length, 1);
    assert.equal(handover.rows[0].state, 'scheduled');
    assert.equal(handover.rows[0].attributes.berth, 'B1');
    assert.equal(handover.asOf, '2026-11-16T08:30:00Z');

    // The original query contract still sees the projected record.
    const records = await service.query({ source: '港口窗口计划簿' });
    assert.equal(records.length, 1);
    assert.ok(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).observations.length === 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a reviewer-confirmed link is stored without merging plans', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'link-'));
  try {
    const repository = new RecordRepository(join(directory, 'state.json'));
    const service = new CollectionService(repository);
    await service.ingest([window(), agent()], { receivedAt: '2026-11-16T08:05:00Z' });
    await service.recordIdentity([{ source: 'agent', sourceWindowId: 'A7', vesselId: 'IMO-1', confirmedBy: 'dispatcher-local' }]);

    const board = await readOperations(repository);
    assert.equal(board.rows.length, 2, '仍保留两条来源计划');
    assert.equal(board.rows.find((row) => row.source === '代理靠泊计划').identity.status, 'confirmed');
    assert.equal(board.rows.find((row) => row.source === '代理靠泊计划').identity.basis.confirmedBy, 'dispatcher-local');
    assert.deepEqual((await repository.readIdentity()).map((link) => link.vesselId), ['IMO-1']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
