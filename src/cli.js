import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';
import { collectSource } from './collect.js';
import { SourceClient } from './source-client.js';
import { startSource } from '../source/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const statePath = resolve(process.env.PORT_BOARD_STATE ?? resolve(here, '../var/records.json'));
const repository = new RecordRepository(statePath);
const service = new CollectionService(repository);
const action = process.argv[2] ?? '--help';

if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | collect [--url 地址] [--received-at 时间] | board [--as-of 时间] | history [--as-of 时间] | link [身份依据文件]',
    commands: ['ingest', 'query'],
    extensions: ['collect', 'board', 'history', 'link'],
    notes: [
      '原导入和查询保持 ingest、query 动作，集合形状不变',
      'collect 从本地来源读取完整批次（含 rel=next 翻页），可重复运行以记录来源修订',
      'board 返回当前值班视图；--as-of 按当时已接收的信息重建交接视图',
      'history 返回保留的原始观察；link 记录人工确认的跨来源身份依据（不改动计划）',
    ],
  }));
  process.exit(0);
}

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'collect') {
  // Prefer an already-running loopback source via --url; otherwise start the
  // bundled fixture source.  SourceClient refuses non-loopback origins.
  const fixture = option('--fixture', resolve(here, '../fixtures/source.json'));
  const base = option('--url');
  const source = base ? null : await startSource(fixture);
  try {
    const client = new SourceClient(base ?? source.url);
    const receivedAt = option('--received-at', new Date().toISOString());
    const port = await collectSource(client, { format: 'port' });
    const agent = await collectSource(client, { format: 'agent' });
    const result = await service.ingest([...port.records, ...agent.records], { receivedAt });
    console.log(JSON.stringify({ ...result, receivedAt, pages: port.pages.length + agent.pages.length }, null, 2));
  } finally { await source?.close(); }
} else if (action === 'board') {
  const board = await readOperations(repository, { asOf: option('--as-of') });
  console.log(JSON.stringify(board, null, 2));
} else if (action === 'history') {
  // Only observations received by `asOf`; this is the raw audit trail, not a
  // guarantee of completeness or success.
  const asOf = option('--as-of');
  const cutoff = asOf ? Date.parse(asOf) : null;
  if (asOf && !Number.isFinite(cutoff)) throw new Error('invalid --as-of');
  const observations = await service.history();
  console.log(JSON.stringify(cutoff === null ? observations
    : observations.filter((record) => Date.parse(record.receivedAt) <= cutoff), null, 2));
} else if (action === 'link') {
  const links = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/identity.json'), 'utf8'));
  console.log(JSON.stringify(await service.recordIdentity(links), null, 2));
} else {
  throw new Error('action must be ingest or query (extensions: collect, board, history, link)');
}
