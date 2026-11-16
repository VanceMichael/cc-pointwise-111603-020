import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  const repository = new RecordRepository(join(directory, 'records.json'));
  await new CollectionService(repository).ingest(page.records);
  console.log(JSON.stringify(await readOperations(repository), null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
