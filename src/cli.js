import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';
import { SourceClient } from './source-client.js';
import { entryPath, sourceEntries } from './adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const repository = new RecordRepository(resolve(here, '../var/records.json'));
const service = new CollectionService(repository);

function flag(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args, name) { return args.includes(`--${name}`); }

function placeArgs(args) {
  // Positional arguments are everything not consumed by the action or a flag.
  const rest = args.slice(3);
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index].startsWith('--')) { index += 1; continue; }
    positional.push(rest[index]);
  }
  return positional;
}

const action = process.argv[2] ?? '--help';
const args = process.argv;
if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | ingest --source <url> [选项] | ingest --identity <文件> | query [来源]',
    commands: ['ingest', 'query'],
    help: [
      'ingest [文件]                         导入本地结构化记录（原有行为）',
      'ingest --source <url> [--source-key port|agent] [--path <入口路径>] [--as-of <时间>] [--etag <etag>]',
      '                                      读取一次来源页面（含 rel=next 后续页）并保留原始窗口与版本',
      'ingest --identity <文件>               记录跨来源身份决定（仅作为复核依据，不自动合并计划）',
      'query [来源]                          原有集合查询',
      'query --as-of <时间> [--include-cancelled|--hide-cancelled] [--history] [--coverage]',
      '                                      按当时已收到的信息重建计划；默认包含恢复、暂时延迟与已取消计划',
    ],
    notes: [
      'asOf 只使用收到时间，来源 modifiedAt 只用于同一窗口内的版本先后。',
      '名称相同不合并计划；缺少 vesselId 且无人工身份决定时会提示人工核查。',
    ],
  }, null, 2));
  process.exit(0);
}
if (action === 'ingest') {
  if (flag(args, 'identity')) {
    const decisions = JSON.parse(await readFile(flag(args, 'identity'), 'utf8'));
    console.log(JSON.stringify(await service.recordIdentityDecisions(decisions, {
      receivedAt: flag(args, 'as-of'),
    }), null, 2));
  } else if (flag(args, 'source')) {
    const key = flag(args, 'source-key') ?? 'port';
    const path = flag(args, 'path') ?? sourceEntries[key] ?? entryPath;
    const result = await service.ingestPage(new SourceClient(flag(args, 'source')), path, {
      sourceKey: key,
      etag: flag(args, 'etag') ?? null,
      receivedAt: flag(args, 'as-of') ?? new Date().toISOString(),
    });
    console.log(JSON.stringify({
      accepted: result.accepted ?? 0,
      notModified: result.notModified ?? false,
      ...(result.notModified ? {} : {
        stored: result.stored, observationsAdded: result.observationsAdded,
        changed: result.changed, ingested: result.ingested,
      }),
    }, null, 2));
  } else {
    const positional = placeArgs(args);
    const records = JSON.parse(await readFile(positional[0] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
    const result = await service.ingest(records, { receivedAt: flag(args, 'as-of') });
    if (flag(args, 'identity')) {
      const decisions = JSON.parse(await readFile(flag(args, 'identity'), 'utf8'));
      result.identity = await service.recordIdentityDecisions(decisions, {
        receivedAt: flag(args, 'as-of') ?? new Date().toISOString(),
      });
    }
    console.log(JSON.stringify(result, null, 2));
  }
} else if (action === 'query') {
  const source = placeArgs(args)[0];
  if (has(args, 'as-of') || has(args, 'history') || has(args, 'coverage') || has(args, 'include-cancelled')
    || has(args, 'hide-cancelled') || has(args, 'plans')) {
    const operations = await readOperations(repository, {
      asOf: flag(args, 'as-of'),
      includeCancelled: !has(args, 'hide-cancelled'),
    });
    const view = source ? { ...operations, plans: operations.plans.filter((plan) => plan.sources.includes(source)) } : operations;
    if (has(args, 'history')) {
      const state = await repository.readState();
      view.history = state.ingests;
    }
    console.log(JSON.stringify(view, null, 2));
  } else {
    console.log(JSON.stringify(await service.query({ source }), null, 2));
  }
} else {
  throw new Error('action must be ingest or query');
}
