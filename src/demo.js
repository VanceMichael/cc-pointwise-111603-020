import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { collectSource } from './collect.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const client = new SourceClient(source.url);
  const repository = new RecordRepository(join(directory, 'records.json'));
  const service = new CollectionService(repository);

  const opening = { port: await collectSource(client, { format: 'port' }), agent: await collectSource(client, { format: 'agent' }) };
  const receivedOpening = '2026-11-16T08:05:00Z';
  await service.ingest([...opening.port.records, ...opening.agent.records], { receivedAt: receivedOpening });
  const openingBoard = await readOperations(repository, { asOf: receivedOpening });

  source.publish('updated');
  const updated = { port: await collectSource(client, { format: 'port' }), agent: await collectSource(client, { format: 'agent' }) };
  const receivedUpdate = '2026-11-16T09:05:00Z';
  await service.ingest([...updated.port.records, ...updated.agent.records], { receivedAt: receivedUpdate });

  const current = await readOperations(repository);
  const handover = await readOperations(repository, { asOf: receivedOpening });
  console.log(JSON.stringify({
    openingRows: openingBoard.rows.map((row) => ({ source: row.source, sourceId: row.sourceId, state: row.state })),
    currentRows: current.rows.map((row) => ({ source: row.source, sourceId: row.sourceId, state: row.state, identity: row.identity.status })),
    reviews: current.reviews,
    handoverStillShowsOpening: JSON.stringify(handover.rows.map((row) => row.state)) === JSON.stringify(openingBoard.rows.map((row) => row.state)),
  }, null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
