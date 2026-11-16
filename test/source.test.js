import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { readOperations } from '../src/operations.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);

test('source adapter, persistence and operations consumer agree on a first import', async () => {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'source-integration-'));
  try {
    const client = new SourceClient(source.url);
    const page = parsePage(await client.read(entryPath));
    assert.ok(page.records.length > 0);
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository);
    await service.ingest(page.records);
    const view = await readOperations(repository);
    assert.equal(view.rows.length, page.records.length);
    assert.ok(view.rows.every((row) => row.sourceId && row.attributes));
    assert.ok(source.requests.some((request) => request.path === entryPath));
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('local origin restriction and transient source failures are observable', async () => {
  assert.throws(() => new SourceClient('https://example.com'), /local source/);
  const source = await startSource(scenarioPath);
  try {
    const client = new SourceClient(source.url);
    source.failNext(entryPath, 503);
    await assert.rejects(client.read(entryPath), /503/);
    assert.ok(parsePage(await client.read(entryPath)).records.length);
    await assert.rejects(client.read('http://127.0.0.1:1/foreign'), /origin changed/);
  } finally { await source.close(); }
});
