import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { collectSource } from './collect.js';
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

  // 1. Baseline: the original first-page import still works unchanged.
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const first = await service.ingest(page.records, { receivedAt: '2026-11-16T08:05:00Z' });
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records, { receivedAt: '2026-11-16T08:06:00Z' });
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');

  // 2. Complete batch: both sources, all pages, current and handover views.
  source.publish('paged');
  const port = await collectSource(client, { format: 'port' });
  const agent = await collectSource(client, { format: 'agent' });
  assert.ok(port.pages.length >= 2 && agent.pages.length >= 2, '须跟随 rel=next 读取完整批次');
  await service.ingest([...port.records, ...agent.records], { receivedAt: '2026-11-16T08:10:00Z' });
  const board = await readOperations(reopened);
  const handover = await readOperations(reopened, { asOf: '2026-11-16T08:05:30Z' });
  assert.ok(board.rows.some((row) => row.source === '代理靠泊计划'), '代理来源进入业务读取入口');
  assert.ok(handover.rows.every((row) => row.attributes.source === 'port'), '交接视图只含当时已收到的来源');

  // 3. Withdrawal and restore are source revisions, kept in history.
  source.publish('updated');
  const cancelled = await collectSource(client, { format: 'port' });
  await service.ingest(cancelled.records, { receivedAt: '2026-11-16T09:10:00Z' });
  const afterCancel = await readOperations(reopened);
  const w1 = afterCancel.rows.find((row) => row.sourceId === 'W1');
  assert.equal(w1.withdrawn, true);
  assert.equal(w1.identity.status, 'confirmed', '改名不影响来源明确的身份');
  source.publish('restored');
  const restored = await collectSource(client, { format: 'port' });
  await service.ingest(restored.records, { receivedAt: '2026-11-16T10:10:00Z' });
  assert.equal((await readOperations(reopened)).rows.find((row) => row.sourceId === 'W1').active, true);

  const operations = await readOperations(reopened);
  console.log(JSON.stringify({
    accepted: first.accepted,
    persisted: stored.length,
    replayStored: second.stored,
    operationRows: operations.rows.length,
    reviews: operations.reviews.length,
    history: (await reopened.readObservations()).length,
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
