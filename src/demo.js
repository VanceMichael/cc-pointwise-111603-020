import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const repository = new RecordRepository(join(directory, 'records.json'));
  const service = new CollectionService(repository);
  const client = new SourceClient(source.url);
  // Two sources, two pages: the port page and the agent page as first seen.
  await service.ingestPage(client, entryPath, { sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z' });
  await service.ingestPage(client, '/agents/windows', { sourceKey: 'agent', receivedAt: '2026-11-16T10:01:00Z' });
  // The agent page has no vesselId; a dispatcher confirms it is the port's W1 vessel.
  await service.recordIdentityDecisions([
    { sourceKey: 'agent', sourceWindowId: 'A7', vesselId: 'IMO-LOCAL-1', confirmedBy: 'dispatcher-local' },
  ], { receivedAt: '2026-11-16T10:02:00Z' });
  // The port later renames the vessel, moves the berth and cancels the window.
  source.publish('updated');
  await service.ingestPage(client, entryPath, { sourceKey: 'port', receivedAt: '2026-11-16T11:00:00Z' });
  console.log(JSON.stringify(await readOperations(repository), null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
