export class SourceClient {
  constructor(baseUrl) {
    const address = new URL(baseUrl);
    if (address.hostname !== '127.0.0.1') throw new Error('local source required');
    this.baseUrl = address;
  }

  async read(path) {
    const address = new URL(path, this.baseUrl);
    if (address.origin !== this.baseUrl.origin) throw new Error('source origin changed');
    const response = await fetch(address, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`source ${response.status}: ${path}`);
    return { text: await response.text(), contentType: response.headers.get('content-type') };
  }
}
