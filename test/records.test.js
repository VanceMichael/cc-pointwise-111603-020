import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRecord, mergeRecords, findRecords } from '../src/records.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';

const sample = (sourceId, observedAt, label = sourceId) => ({
  sourceId, source: 'sample-source', observedAt, label, attributes: { local: true },
});

test('normalization validates identity, source, time, and clones attributes', () => {
  const input = sample('r-1', '2026-11-16T09:00:00Z');
  const normalized = normalizeRecord(input);
  assert.notEqual(normalized.attributes, input.attributes);
  assert.throws(() => normalizeRecord({ ...input, sourceId: '' }), /missing sourceId/);
  assert.throws(() => normalizeRecord({ ...input, observedAt: 'not-a-date' }), /invalid observedAt/);
});

test('merge is idempotent and an older observation cannot replace a newer one', () => {
  const first = normalizeRecord(sample('r-1', '2026-11-16T10:00:00Z', 'new'));
  const older = normalizeRecord(sample('r-1', '2026-11-16T09:00:00Z', 'old'));
  assert.deepEqual(mergeRecords([first], [older, first]), [first]);
});

test('queries filter by source and inclusive time boundaries', () => {
  const rows = [normalizeRecord(sample('a', '2026-11-16T09:00:00Z')), normalizeRecord(sample('b', '2026-11-16T10:00:00Z'))];
  assert.deepEqual(findRecords(rows, { source: 'sample-source', from: '2026-11-16T10:00:00Z' }).map((row) => row.sourceId), ['b']);
});

test('service persists accepted records and restarts from repository state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collector-'));
  try {
    const path = join(directory, 'state', 'records.json');
    const service = new CollectionService(new RecordRepository(path));
    assert.deepEqual(await service.ingest([sample('r-1', '2026-11-16T09:00:00Z')]), { accepted: 1, stored: 1 });
    const restarted = new CollectionService(new RecordRepository(path));
    assert.equal((await restarted.query({})).length, 1);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).records[0].sourceId, 'r-1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
