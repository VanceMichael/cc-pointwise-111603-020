import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('port source preserves vessel identity while changing name, berth and cancellation', async () => {
  const initial = (await observe()).records[0].attributes;
  const cancelled = (await observe('updated')).records[0].attributes;
  assert.equal(initial.vesselId, cancelled.vesselId);
  assert.notEqual(initial.vesselName, cancelled.vesselName);
  assert.notEqual(initial.berth, cancelled.berth);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await fixture('identity'))[0].sourceWindowId, initial.sourceWindowId);
});
