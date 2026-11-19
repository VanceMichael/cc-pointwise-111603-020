export const entryPath = '/ports/P1/windows';
export const agentPath = '/agents/windows';

/**
 * Human-readable source names.  The raw portal value is kept in
 * `attributes.source` ("port" / "agent") and is what identity is compared on.
 */
export const sourceNames = Object.freeze({
  port: '港口窗口计划簿',
  agent: '代理靠泊计划',
});

export function sourceName(raw) {
  return sourceNames[raw] ?? String(raw ?? '未知来源');
}

function toRecord(item, rawSource) {
  return {
    sourceId: String(item.sourceWindowId),
    source: sourceName(rawSource),
    observedAt: item.modifiedAt,
    // `label` is display-only.  A missing name never confirms identity, so fall
    // back to the source window id instead of rejecting the window.
    label: String(item.vesselName ?? '').trim() || String(item.sourceWindowId),
    attributes: structuredClone(item),
  };
}

/** Parse the port HTML page, keeping every portal field unchanged. */
export function parsePage(response, { rawSource = 'port' } = {}) {
  const items = [...response.text.matchAll(/<script type="application\/json" class="source-record">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  if (!items.length) throw new Error('source layout contains no records');
  const next = response.text.match(/rel="next" href="([^"]+)"/)?.[1] ?? null;
  return { next, records: items.map((item) => toRecord(item, item.source ?? rawSource)) };
}

/** Parse an agent JSON page; `next` may be relative to the requested path. */
export function parseAgentPage(response, { path = agentPath, rawSource = 'agent' } = {}) {
  const body = typeof response.text === 'string' ? JSON.parse(response.text) : response.text;
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) throw new Error('source layout contains no records');
  const target = body.next ? new URL(body.next, `http://source.invalid${path}`) : null;
  const next = target ? `${target.pathname}${target.search}` : null;
  return { next, records: items.map((item) => toRecord(item, item.source ?? rawSource)) };
}
