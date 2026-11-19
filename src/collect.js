import { agentPath, entryPath, parseAgentPage, parsePage } from './adapter.js';
import { SourceClient } from './source-client.js';

/**
 * Follow rel=next / next links so a collection run is a complete batch rather
 * than only the first page.  Each page is parsed by the adapter for its source.
 * A failed page aborts the batch: a partial page list must not look complete.
 */
export async function collectSource(client, { path, format = 'port', maxPages = 50 } = {}) {
  const records = [];
  const pages = [];
  const seen = new Set();
  let next = path ?? (format === 'agent' ? agentPath : entryPath);
  while (next && pages.length < maxPages) {
    if (seen.has(next)) throw new Error(`source pagination loop at ${next}`);
    seen.add(next);
    const response = await client.read(next);
    const page = format === 'agent' ? parseAgentPage(response, { path: next }) : parsePage(response);
    pages.push({ path: next, records: page.records.length });
    records.push(...page.records);
    next = page.next;
  }
  if (next) throw new Error(`source exceeded ${maxPages} pages`);
  return { records, pages, complete: true };
}

export { entryPath, agentPath };
