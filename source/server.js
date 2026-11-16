import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

export async function startSource(scenarioPath) {
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
  let stage = Object.keys(scenario.stages)[0];
  const requests = [];
  const faults = new Map();
  const server = createServer(async (request, response) => {
    const path = request.url;
    requests.push({ method: request.method, path, stage });
    const queue = faults.get(path);
    if (queue?.length) {
      const fault = queue.shift();
      if (fault === 'disconnect') { request.socket.destroy(); return; }
      response.writeHead(fault, { 'retry-after': '0' });
      response.end('source temporarily unavailable');
      return;
    }
    const route = scenario.stages[stage].routes[path];
    if (request.method !== 'GET' || !route) {
      response.writeHead(404); response.end('unknown source resource'); return;
    }
    if (request.headers['if-none-match'] === route.etag && route.etag) {
      response.writeHead(304, { etag: route.etag }); response.end(); return;
    }
    if (request.headers['if-match'] && request.headers['if-match'] !== route.etag) {
      response.writeHead(412); response.end('source entity changed'); return;
    }
    if (request.headers.range && typeof route.body === 'string') {
      const match = request.headers.range.match(/^bytes=(\d+)-$/);
      const bytes = Buffer.from(route.body);
      const offset = match ? Number(match[1]) : -1;
      if (offset < 0 || offset >= bytes.length) {
        response.writeHead(416, { 'content-range': `bytes */${bytes.length}` }); response.end(); return;
      }
      response.writeHead(206, { 'content-type': route.contentType,
        'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
        'content-length': bytes.length - offset, ...(route.etag ? { etag: route.etag } : {}) });
      response.end(bytes.subarray(offset)); return;
    }
    response.writeHead(route.status ?? 200, {
      'content-type': route.contentType ?? 'application/json',
      ...(route.etag ? { etag: route.etag } : {}),
      ...(route.headers ?? {}),
    });
    response.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    publish(next) {
      if (!scenario.stages[next]) throw new Error(`unknown stage: ${next}`);
      stage = next;
    },
    failNext(path, status) {
      if (!faults.has(path)) faults.set(path, []);
      faults.get(path).push(status);
    },
    close() { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}
