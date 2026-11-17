import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { readFile } from 'node:fs/promises';
import { entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const client = new SourceClient(source.url);
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const service = new CollectionService(repository);

  // One pass over both sources, then a restart and a replay of the same pages.
  const first = await service.ingestPage(client, entryPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
  assert.ok(first.accepted > 0, '初始来源须有可接收的业务记录');
  await service.ingestPage(client, '/agents/windows', { sourceKey: 'agent', receivedAt: '2026-11-16T10:01:00Z' });
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const replay = await new CollectionService(reopened).ingestPage(client, entryPath,
    { sourceKey: 'port', receivedAt: '2026-11-16T10:05:00Z' });
  assert.equal((await reopened.readState()).observations.length, 2, '重放不重复保存版本');

  // An agent window without vesselId is never merged by name alone.
  let view = await readOperations(reopened);
  assert.equal(view.plans.length, 2, '同名但无身份依据时不得合并计划');
  assert.ok(view.conflicts.some((conflict) => conflict.code === 'berth-overlap'), '同泊位重叠须提示人工核查');
  assert.ok(view.manualReview.some((item) => item.code === 'identity-unconfirmed'));

  // A recorded dispatcher decision links them; neither berth is moved.
  const identities = JSON.parse(await readFile(new URL('../fixtures/identity.json', import.meta.url), 'utf8'));
  await service.recordIdentityDecisions(identities, { receivedAt: '2026-11-16T10:02:00Z' });
  view = await readOperations(reopened);
  assert.equal(view.plans.length, 1, '明确身份决定后为同一条计划');
  assert.deepEqual(view.plans[0].windows.map((window) => window.berth), ['B1', 'B1']);

  // A later explicit cancellation stays visible with its source evidence.
  source.publish('updated');
  await new CollectionService(reopened).ingestPage(client, entryPath,
    { sourceKey: 'port', receivedAt: '2026-11-16T11:00:00Z' });
  const now = await readOperations(reopened);
  const plan = now.plans.find((item) => item.vesselId === 'IMO-LOCAL-1');
  assert.equal(plan.status, 'disputed');
  assert.equal(plan.evidence.cancellation.sourceKey, 'port');
  assert.equal(plan.evidence.cancellation.receivedAt, '2026-11-16T11:00:00Z');
  assert.ok(plan.windows.find((window) => window.sourceKey === 'port').history.length >= 2, '旧窗口版本须保留');
  assert.equal(plan.windows.find((window) => window.sourceKey === 'port').berth, 'B2');

  // Replaying the handover at 10:30 must not show the 11:00 page.
  const then = await readOperations(reopened, { asOf: '2026-11-16T10:30:00Z' });
  const pastPlan = then.plans.find((item) => item.vesselId === 'IMO-LOCAL-1');
  assert.equal(pastPlan.status, 'scheduled');
  assert.equal(pastPlan.windows.find((window) => window.sourceKey === 'port').berth, 'B1');
  assert.equal(pastPlan.evidence.cancellation, null);

  // A restoration is recorded separately from the cancellation it followed.
  source.publish('restored');
  await new CollectionService(reopened).ingestPage(client, entryPath,
    { sourceKey: 'port', receivedAt: '2026-11-16T12:00:00Z' });
  const restored = (await readOperations(reopened)).plans.find((item) => item.vesselId === 'IMO-LOCAL-1');
  assert.equal(restored.evidence.restoration.restoredAt, '2026-11-16T10:00:00Z');
  assert.equal(restored.evidence.cancellation, null);

  // A temporary delay shifts the window without being treated as a cancellation.
  source.publish('delayed');
  await new CollectionService(reopened).ingestPage(client, entryPath,
    { sourceKey: 'port', receivedAt: '2026-11-16T13:00:00Z' });
  const delayed = (await readOperations(reopened)).plans.find((item) => item.vesselId === 'IMO-LOCAL-1');
  assert.equal(delayed.evidence.delay.previousStartsAt, '2026-11-17T01:00:00Z');
  assert.equal(delayed.evidence.delay.startsAt, '2026-11-17T03:00:00Z');

  const operations = await readOperations(reopened);
  const latest = await reopened.read();
  assert.deepEqual(operations.rows.map((row) => row.sourceId).sort(), latest.map((row) => row.sourceId).sort());
  for (const row of operations.rows) {
    const original = latest.find((record) => record.sourceId === row.sourceId);
    assert.equal(row.source, original.source);
    assert.equal(row.observedAt, original.observedAt);
    for (const [field, value] of Object.entries(row.attributes)) assert.deepEqual(value, original.attributes[field] ?? null);
  }
  console.log(JSON.stringify({
    accepted: first.accepted, persisted: stored.length, replayObservations: (await reopened.readState()).observations.length,
    plans: operations.plans.length, reviewItems: operations.manualReview.length,
    asOfPlans: then.plans.length, status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
