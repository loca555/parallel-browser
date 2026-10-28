import http from 'node:http';
import net from 'node:net';
import { Resolver } from 'node:dns/promises';
import { Transform } from 'node:stream';

export class PublicUrlError extends Error {
  constructor(message, code = 'PUBLIC_URL_REQUIRED') {
    super(message);
    this.name = 'PublicUrlError';
    this.code = code;
  }
}

const blockedIPv4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedIPv4.addSubnet(address, prefix, 'ipv4');

export function isPublicIPv4(address) {
  return net.isIP(address) === 4 && !blockedIPv4.check(address, 'ipv4');
}

function parseUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\u0000-\u0020\u007f]/.test(raw)) {
    throw new PublicUrlError('Enter a valid public website URL.');
  }
  let url;
  try { url = new URL(raw); } catch { throw new PublicUrlError('Enter a valid public website URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new PublicUrlError('Only HTTP and HTTPS websites are supported.');
  if (url.username || url.password) throw new PublicUrlError('URLs with embedded credentials are not supported.');
  if (url.port) throw new PublicUrlError('Only the standard HTTP and HTTPS ports are supported.');
  let hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || net.isIP(hostname) === 6 || hostname.includes(':')) {
    throw new PublicUrlError('Only public IPv4 websites are supported.');
  }
  if (net.isIP(hostname) === 4) {
    if (!isPublicIPv4(hostname)) throw new PublicUrlError('Private and reserved network addresses are not supported.');
  } else {
    if (!hostname.includes('.') || /(^|\.)(localhost|local|localdomain|internal)$/.test(hostname)) {
      throw new PublicUrlError('Local and internal websites are not supported.');
    }
    if (!hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new PublicUrlError('Enter a valid public website hostname.');
    }
  }
  url.hostname = hostname;
  return url;
}

async function defaultLookup(hostname, timeoutMs) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  let timeout;
  try {
    return await Promise.race([
      resolver.resolve4(hostname),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          resolver.cancel();
          reject(new PublicUrlError('Website DNS lookup timed out.', 'DNS_TIMEOUT'));
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timeout); }
}

export function createPublicUrlPolicy({ lookup = defaultLookup, dnsTimeoutMs = 5000, dnsTtlMs = 30000, maxDnsEntries = 256, blockedHostnames = [] } = {}) {
  const cache = new Map();
  const pending = new Map();
  const blockedNames = new Set(blockedHostnames.map(host => String(host).toLowerCase().replace(/\.$/, '')));
  async function resolvePublicIPv4(urlOrHostname) {
    const hostname = typeof urlOrHostname === 'string' ? urlOrHostname : urlOrHostname.hostname;
    if (blockedNames.has(hostname)) throw new PublicUrlError('This application cannot be opened inside its browser preview.');
    if (net.isIP(hostname) === 4) {
      if (!isPublicIPv4(hostname)) throw new PublicUrlError('Private and reserved network addresses are not supported.');
      return hostname;
    }
    const cached = cache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) return cached.address;
    if (pending.has(hostname)) return pending.get(hostname);
    if (pending.size >= 64) throw new PublicUrlError('Browser DNS capacity is busy. Please retry.', 'DNS_BUSY');
    const operation = (async () => {
      let timer;
      try {
        const records = await Promise.race([
          Promise.resolve().then(() => lookup(hostname, dnsTimeoutMs)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new PublicUrlError('Website DNS lookup timed out.', 'DNS_TIMEOUT')), dnsTimeoutMs);
          }),
        ]);
        const addresses = Array.isArray(records) ? records.map(record => typeof record === 'string' ? record : record.address) : [];
        if (!addresses.length || addresses.some(address => !isPublicIPv4(address))) {
          throw new PublicUrlError('This website resolves to an unsupported network address.');
        }
        const address = addresses[0];
        if (cache.size >= maxDnsEntries) cache.delete(cache.keys().next().value);
        cache.set(hostname, { address, expiresAt: Date.now() + dnsTtlMs });
        return address;
      } catch (error) {
        if (error instanceof PublicUrlError) throw error;
        throw new PublicUrlError('The public website hostname could not be resolved.', 'DNS_FAILED');
      } finally { clearTimeout(timer); pending.delete(hostname); }
    })();
    pending.set(hostname, operation);
    return operation;
  }
  async function validate(raw) {
    const url = parseUrl(raw);
    await resolvePublicIPv4(url);
    return url;
  }
  return { validatePublicUrl: validate, resolvePublicIPv4 };
}

const defaultPolicy = createPublicUrlPolicy();
export const validatePublicUrl = raw => defaultPolicy.validatePublicUrl(raw);

export function parseConnectAuthority(authority) {
  if (typeof authority !== 'string' || !/^[a-z0-9.-]+:443$/i.test(authority)) {
    throw new PublicUrlError('Only HTTPS tunnels on port 443 are supported.');
  }
  return parseUrl('https://' + authority);
}

function filteredHeaders(headers) {
  const excluded = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const name of String(headers.connection || '').split(',')) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

function byteLimiter(limit) {
  let bytes = 0;
  return new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    callback(bytes > limit ? new Error('Transfer limit exceeded.') : null, chunk);
  } });
}

export async function startPublicProxy({
  policy = defaultPolicy,
  connect = options => net.connect(options),
  request = (options, callback) => http.request(options, callback),
  maxConnections = 64,
  maxOperations = 32,
  socketTimeoutMs = 30000,
  operationTimeoutMs = 120000,
  maxTunnelBytes = 32 * 1024 * 1024,
  maxResponseBytes = 16 * 1024 * 1024,
  maxUploadBytes = 2 * 1024 * 1024,
} = {}) {
  let closing = false;
  let operations = 0;
  let reservedSockets = 0;
  const sockets = new Set();
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: operationTimeoutMs, headersTimeout: Math.min(socketTimeoutMs, operationTimeoutMs) });
  server.maxConnections = maxConnections;
  const trackSocket = socket => {
    if (closing || sockets.size + reservedSockets >= maxConnections) { socket.destroy(); return false; }
    sockets.add(socket);
    socket.setTimeout(socketTimeoutMs, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    return true;
  };
  function reserveSocket() {
    if (closing || sockets.size + reservedSockets >= maxConnections) throw new PublicUrlError('Browser network capacity is busy.', 'NETWORK_BUSY');
    reservedSockets++;
    let reserved = true;
    return () => { if (reserved) { reserved = false; reservedSockets--; } };
  }
  function beginOperation() {
    if (closing || operations >= maxOperations) throw new PublicUrlError('Browser network capacity is busy.', 'NETWORK_BUSY');
    operations++;
    let active = true;
    return () => { if (active) { active = false; operations--; } };
  }
  const safeMessage = error => error instanceof PublicUrlError ? error.message : 'Public website connection failed.';
  function rejectHttp(response, error, status = 403) {
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
    response.end(safeMessage(error));
  }
  function rejectTunnel(socket, error, status = 403) {
    if (socket.destroyed) return;
    const body = Buffer.from(safeMessage(error));
    const reason = status === 503 ? 'Service Unavailable' : status === 502 ? 'Bad Gateway' : 'Forbidden';
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  }
  server.on('connection', trackSocket);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => rejectTunnel(socket, new PublicUrlError('Unencrypted WebSocket upgrades are not supported.')));
  server.on('request', async (incoming, response) => {
    let finish = () => {};
    let releaseSocket = () => {};
    let outgoing;
    let upstream;
    let timer;
    let completed = false;
    const done = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      releaseSocket();
      finish();
    };
    try {
      finish = beginOperation();
      response.once('close', () => { outgoing?.destroy(); upstream?.destroy(); done(); });
      incoming.once('aborted', () => { outgoing?.destroy(); done(); });
      incoming.once('error', () => { outgoing?.destroy(); done(); });
      response.once('error', () => { outgoing?.destroy(); upstream?.destroy(); done(); });
      const contentLength = Number(incoming.headers['content-length'] || 0);
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxUploadBytes) {
        throw new PublicUrlError('Website upload exceeds the browser preview limit.', 'UPLOAD_LIMIT');
      }
      const url = await policy.validatePublicUrl(incoming.url);
      if (url.protocol !== 'http:') throw new PublicUrlError('HTTPS websites must use a secure tunnel.');
      const address = await policy.resolvePublicIPv4(url);
      if (closing || response.destroyed || incoming.aborted) { done(); return; }
      releaseSocket = reserveSocket();
      const headers = filteredHeaders(incoming.headers);
      headers.host = url.host;
      outgoing = request({ hostname: address, family: 4, port: 80, method: incoming.method, path: url.pathname + url.search, headers, agent: false }, remote => {
        upstream = remote;
        const length = Number(remote.headers['content-length'] || 0);
        if (!Number.isFinite(length) || length < 0 || length > maxResponseBytes) {
          remote.destroy(); rejectHttp(response, new PublicUrlError('Website resource exceeds the browser preview limit.'), 413); return;
        }
        response.writeHead(remote.statusCode || 502, filteredHeaders(remote.headers));
        const limiter = byteLimiter(maxResponseBytes);
        limiter.once('error', () => { remote.destroy(); response.destroy(); done(); });
        remote.once('error', () => { response.destroy(); done(); });
        remote.pipe(limiter).pipe(response);
      });
      outgoing.once('socket', socket => { releaseSocket(); trackSocket(socket); });
      outgoing.once('error', error => { releaseSocket(); rejectHttp(response, error, 502); done(); });
      timer = setTimeout(() => { outgoing.destroy(); rejectHttp(response, new PublicUrlError('Website connection timed out.'), 504); done(); }, operationTimeoutMs);
      timer.unref?.();
      const limiter = byteLimiter(maxUploadBytes);
      limiter.once('error', () => { outgoing.destroy(); rejectHttp(response, new PublicUrlError('Website upload exceeds the browser preview limit.'), 413); done(); });
      incoming.pipe(limiter).pipe(outgoing);
    } catch (error) {
      releaseSocket();
      rejectHttp(response, error, error.code === 'NETWORK_BUSY' ? 503 : error.code === 'UPLOAD_LIMIT' ? 413 : 403);
      done();
    }
  });
  server.on('connect', async (incoming, client, head) => {
    let finish = () => {};
    let releaseSocket = () => {};
    let remote;
    let timer;
    let completed = false;
    const done = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      releaseSocket();
      remote?.destroy();
      client.destroy();
      finish();
    };
    try {
      finish = beginOperation();
      client.once('close', done);
      client.once('error', done);
      const url = parseConnectAuthority(incoming.url);
      await policy.validatePublicUrl(url.href);
      const address = await policy.resolvePublicIPv4(url);
      if (closing || client.destroyed) { done(); return; }
      releaseSocket = reserveSocket();
      remote = connect({ host: address, port: 443, family: 4 });
      releaseSocket();
      if (!trackSocket(remote)) { rejectTunnel(client, new PublicUrlError('Browser network capacity is busy.'), 503); done(); return; }
      remote.once('error', error => { rejectTunnel(client, error, 502); done(); });
      remote.once('close', done);
      timer = setTimeout(done, operationTimeoutMs);
      timer.unref?.();
      let bytes = head.length;
      const count = chunk => { bytes += chunk.length; if (bytes > maxTunnelBytes) done(); };
      client.on('data', count);
      remote.on('data', count);
      remote.once('connect', () => {
        if (completed || client.destroyed) { done(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        client.pipe(remote);
        remote.pipe(client);
      });
    } catch (error) {
      releaseSocket();
      rejectTunnel(client, error, error.code === 'NETWORK_BUSY' ? 503 : 403);
      // Allow the small rejection response to flush; no upstream socket exists yet.
      client.once('finish', done);
      const cleanup = setTimeout(done, 1000); cleanup.unref?.();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      closing = true;
      const closed = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await closed;
    },
  };
}
