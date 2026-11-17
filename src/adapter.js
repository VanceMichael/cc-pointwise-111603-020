import { createHash } from 'node:crypto';

export const product = '港口窗口计划簿';
export const entryPath = '/ports/P1/windows';

function sourceLabel(value) { return String(value ?? '').trim(); }

function pageIdentity(response) {
  return response.etag ?? response.lastModified ?? response.url ?? null;
}

/**
 * Port page: HTML with embedded source-record JSON nodes and rel=next.
 * The whole upstream object is kept verbatim in `attributes`; nothing that
 * proves identity is flattened away.
 */
export function parsePage(response) {
  const items = [...response.text.matchAll(/<script type="application\/json" class="source-record">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  if (!items.length) throw new Error('source layout contains no records');
  const next = response.text.match(/rel="next" href="([^"]+)"/)?.[1] ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item.sourceWindowId),
    source: product,
    sourceKey: sourceLabel(item.source) || 'port',
    observedAt: item.modifiedAt,
    label: String(item.vesselName ?? ''),
    attributes: structuredClone(item),
  })) };
}

/**
 * Agent page: JSON `{items, next}`. The agent id is preserved alongside the
 * (nullable) vesselId; a name alone is never promoted to an identity.
 */
export function parseAgentPage(response) {
  let payload;
  try { payload = JSON.parse(response.text); } catch { throw new Error('agent layout is not JSON'); }
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) throw new Error('source layout contains no records');
  const next = typeof payload.next === 'string' && payload.next ? payload.next : null;
  return { next, records: items.map((item) => ({
    sourceId: String(item.sourceWindowId),
    source: product,
    sourceKey: sourceLabel(item.source) || 'agent',
    observedAt: item.modifiedAt,
    label: String(item.vesselName ?? ''),
    attributes: structuredClone(item),
  })) };
}

export const parsers = { port: parsePage, agent: parseAgentPage };
export const sourceEntries = { port: '/ports/P1/windows', agent: '/agents/windows' };

/** sha256 of exactly the bytes read; a truncated or reflowed page is detectable. */
export function bodyDigest(response) {
  return createHash('sha256').update(response.text).digest('hex');
}

export function pageMeta(response, path) {
  return {
    path,
    etag: response.etag ?? null,
    lastModified: response.lastModified ?? null,
    digest: bodyDigest(response),
    pageIdentity: pageIdentity(response),
  };
}
