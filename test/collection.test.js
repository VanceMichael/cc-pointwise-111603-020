import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { readOperations } from '../src/operations.js';

test('a paged source is read to the end and stored as one received batch', async () => {
  const source = await startSource(new URL('../fixtures/paged-source.json', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'paged-'));
  try {
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository);
    const result = await service.ingestPage(new SourceClient(source.url), '/ports/P2/windows', {
      sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z',
    });
    assert.equal(result.accepted, 2);
    assert.deepEqual(source.requests.map((request) => request.path),
      ['/ports/P2/windows', '/ports/P2/windows?page=2']);
    const state = await repository.readState();
    assert.equal(state.ingests.length, 1);
    assert.equal(state.ingests[0].pages.length, 2);
    assert.equal(state.observations.length, 2);
    assert.ok(state.observations.every((observation) => observation.receivedAt === '2026-11-16T10:00:00Z'));
    const view = await readOperations(repository);
    assert.equal(view.plans.length, 2);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed later page stores nothing from the partially read source', async () => {
  const source = await startSource(new URL('../fixtures/paged-source.json', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'paged-'));
  try {
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository);
    source.failNext('/ports/P2/windows?page=2', 503);
    await assert.rejects(service.ingestPage(new SourceClient(source.url), '/ports/P2/windows', {
      sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z',
    }), /503/);
    const state = await repository.readState();
    assert.equal(state.observations.length, 0);
    assert.equal(state.ingests.length, 0);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a legacy {records} file is still readable and migrates without losing its window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-'));
  try {
    const path = join(directory, 'records.json');
    const legacy = JSON.parse(await readFile(new URL('../fixtures/records.json', import.meta.url), 'utf8'));
    await writeFile(path, JSON.stringify({ records: legacy }));
    const repository = new RecordRepository(path);
    assert.equal((await repository.read()).length, 1);
    const service = new CollectionService(repository);
    await service.ingest([], { receivedAt: '2026-11-16T10:00:00Z' });
    const state = await repository.readState();
    assert.equal(state.observations.length, 1);
    assert.equal(state.observations[0].migrated, true);
    assert.equal((await service.query({})).length, 1);
    const view = await readOperations(repository);
    assert.equal(view.plans[0].planId, 'vessel:IMO-LOCAL-1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('conditional reads skip an unchanged page without storing a new version', async () => {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'etag-'));
  try {
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository);
    const client = new SourceClient(source.url);
    const first = await service.ingestPage(client, '/ports/P1/windows', {
      sourceKey: 'port', receivedAt: '2026-11-16T10:00:00Z',
    });
    const second = await service.ingestPage(client, '/ports/P1/windows', {
      sourceKey: 'port', receivedAt: '2026-11-16T11:00:00Z', etag: first.etag ?? '"opening"',
    });
    assert.equal(second.notModified, true);
    assert.equal(second.accepted, 0);
    assert.equal((await repository.readState()).observations.length, 1);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
