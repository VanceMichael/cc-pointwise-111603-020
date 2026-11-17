export class SourceClient {
  constructor(baseUrl) {
    const address = new URL(baseUrl);
    if (address.hostname !== '127.0.0.1') throw new Error('local source required');
    this.baseUrl = address;
  }

  async read(path, { etag } = {}) {
    const address = new URL(path, this.baseUrl);
    if (address.origin !== this.baseUrl.origin) throw new Error('source origin changed');
    const headers = etag ? { 'if-none-match': etag } : {};
    const response = await fetch(address, { signal: AbortSignal.timeout(2000), headers });
    if (response.status === 304) {
      return { notModified: true, etag, text: null, contentType: response.headers.get('content-type') };
    }
    if (!response.ok) throw new Error(`source ${response.status}: ${path}`);
    return {
      notModified: false,
      text: await response.text(),
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      url: address.href,
    };
  }
}
