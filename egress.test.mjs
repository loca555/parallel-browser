import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createPublicUrlPolicy, isPublicIPv4, parseConnectAuthority, startPublicProxy } from './egress.mjs';

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const mockPolicy = options => createPublicUrlPolicy({ lookup: async () => ['9.9.9.9'], ...options });

function throughProxy(proxyUrl, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const request = http.request({ hostname: '127.0.0.1', port: proxy.port, path, method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('Test request timed out')));
    request.end(body);
  });
}

test('public IPv4 classifier excludes private and special-use ranges', () => {
  for (const address of ['0.0.0.0', '0.1.2.3', '10.2.3.4', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.169.254', '172.16.1.1', '172.31.255.254', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.1.1', '198.19.255.254', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicIPv4(address), false, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '9.9.9.9', '93.184.216.34', '172.32.0.1', '100.128.0.1']) assert.equal(isPublicIPv4(address), true, address);
});

test('URL validation rejects alternate local spellings, credentials, ports and schemes', async () => {
  const policy = mockPolicy();
  for (const raw of ['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost./', 'http://a.localhost/', 'http://foo.local/', 'http://metadata.google.internal/', 'http://intranet/', 'https://user:pass@example.test/', 'http://example.test:8080/', 'http://example.test:443/', 'https://example.test:80/', 'file:///etc/passwd', 'data:text/html,test', 'https://example.test/\nheader']) {
    await assert.rejects(policy.validatePublicUrl(raw), { name: 'PublicUrlError' }, raw);
  }
  assert.equal((await policy.validatePublicUrl('https://EXAMPLE.test.:443/path#section')).href, 'https://example.test/path#section');
  assert.equal((await policy.validatePublicUrl('http://example.test:80/')).href, 'http://example.test/');
});

test('DNS lookup rejects empty, mixed and rebound private answers', async () => {
  for (const addresses of [[], ['10.0.0.1'], ['9.9.9.9', '127.0.0.1'], ['9.9.9.9', '::1']]) {
    const policy = mockPolicy({ lookup: async () => addresses });
    await assert.rejects(policy.validatePublicUrl('https://example.test/'), { name: 'PublicUrlError' });
  }
  let calls = 0;
  const policy = mockPolicy({ dnsTtlMs: 0, lookup: async () => ++calls === 1 ? ['9.9.9.9'] : ['127.0.0.1'] });
  await policy.validatePublicUrl('https://example.test/');
  await assert.rejects(policy.validatePublicUrl('https://example.test/'), { name: 'PublicUrlError' });
  assert.equal(calls, 2);
});

test('DNS timeout and hostname deny list are bounded and sanitized', async () => {
  const policy = mockPolicy({ dnsTimeoutMs: 30, lookup: () => new Promise(() => {}), blockedHostnames: ['self.example.test'] });
  await assert.rejects(policy.validatePublicUrl('https://self.example.test/'), /application cannot be opened/);
  await assert.rejects(policy.validatePublicUrl('https://example.test/secret?token=not-a-real-token'), error => error.code === 'DNS_TIMEOUT' && !error.message.includes('token'));
});

test('CONNECT authority parser rejects credentials, paths, wrong ports and IPv6', () => {
  for (const authority of ['example.test:80', 'example.test:444', 'user@example.test:443', 'example.test:443/path', 'example.test:443?x=1', '[::1]:443', 'example.test', ' example.test:443']) {
    assert.throws(() => parseConnectAuthority(authority), { name: 'PublicUrlError' }, authority);
  }
  assert.equal(parseConnectAuthority('example.test:443').href, 'https://example.test/');
});

test('HTTP forwarding connects to the vetted IP and preserves website CSP', async t => {
  let seenHeaders;
  const upstream = http.createServer((request, response) => {
    seenHeaders = request.headers;
    assert.equal(request.url, '/view?mode=2');
    response.writeHead(200, { 'Content-Security-Policy': "frame-ancestors 'none'", 'Content-Type': 'text/plain' });
    response.end('public page');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  let lookupCount = 0;
  const policy = mockPolicy({ lookup: async () => { lookupCount++; return ['9.9.9.9']; } });
  let pinnedOptions;
  const proxy = await startPublicProxy({ policy, request: (options, callback) => {
    pinnedOptions = options;
    return http.request({ ...options, hostname: '127.0.0.1', port: upstreamPort }, callback);
  } });
  t.after(() => proxy.close());
  const response = await throughProxy(proxy.url, 'http://example.test/view?mode=2', { headers: { 'Proxy-Authorization': 'Basic dummy', 'X-Check': 'kept' } });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'public page');
  assert.equal(response.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(pinnedOptions.hostname, '9.9.9.9');
  assert.equal(pinnedOptions.family, 4);
  assert.equal(pinnedOptions.port, 80);
  assert.equal(lookupCount, 1);
  assert.equal(seenHeaders.host, 'example.test');
  assert.equal(seenHeaders['x-check'], 'kept');
  assert.equal(seenHeaders['proxy-authorization'], undefined);
});

test('HTTP proxy does not connect after a private DNS answer and limits upload size', async t => {
  let connections = 0;
  const proxy = await startPublicProxy({ policy: mockPolicy({ lookup: async () => ['127.0.0.1'] }), request: () => { connections++; throw new Error('must not connect'); }, maxUploadBytes: 8 });
  t.after(() => proxy.close());
  const denied = await throughProxy(proxy.url, 'http://example.test/');
  assert.equal(denied.status, 403);
  assert.equal(connections, 0);
  const large = await throughProxy(proxy.url, 'http://example.test/', { method: 'POST', headers: { 'Content-Length': '9' }, body: '123456789' });
  assert.equal(large.status, 413);
  assert.equal(connections, 0);
});

test('HTTPS CONNECT pins the vetted IP and transports bytes without rewriting TLS', async t => {
  const fixtureSockets = new Set();
  const upstream = net.createServer(socket => { fixtureSockets.add(socket); socket.once('close', () => fixtureSockets.delete(socket)); socket.pipe(socket); });
  const port = await listen(upstream);
  t.after(async () => { for (const socket of fixtureSockets) socket.destroy(); await close(upstream); });
  let pinned;
  const proxy = await startPublicProxy({ policy: mockPolicy(), connect: options => { pinned = options; return net.connect({ host: '127.0.0.1', port }); } });
  t.after(() => proxy.close());
  const proxyPort = new URL(proxy.url).port;
  const client = net.connect({ host: '127.0.0.1', port: proxyPort });
  t.after(() => client.destroy());
  const result = await new Promise((resolve, reject) => {
    let data = Buffer.alloc(0), sent = false;
    client.once('error', reject);
    client.setTimeout(2000, () => reject(new Error('Tunnel test timed out')));
    client.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (!sent && data.includes('\r\n\r\n')) { sent = true; client.write('test bytes'); }
      if (data.toString().endsWith('test bytes')) resolve(data.toString());
    });
    client.once('connect', () => client.write('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n'));
  });
  assert.match(result, /^HTTP\/1\.1 200 Connection Established\r\n/);
  assert.deepEqual(pinned, { host: '9.9.9.9', port: 443, family: 4 });
});

test('HTTPS CONNECT refuses a private target before opening an upstream socket', async t => {
  let connections = 0;
  const proxy = await startPublicProxy({ connect: () => { connections++; throw new Error('must not connect'); } });
  t.after(() => proxy.close());
  const client = net.connect({ host: '127.0.0.1', port: new URL(proxy.url).port });
  t.after(() => client.destroy());
  const result = await new Promise((resolve, reject) => {
    let data = '';
    client.on('data', chunk => { data += chunk; });
    client.once('end', () => resolve(data));
    client.once('error', reject);
    client.setTimeout(2000, () => reject(new Error('Denied tunnel test timed out')));
    client.once('connect', () => client.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n'));
  });
  assert.match(result, /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(connections, 0);
});

test('HTTP resource size is bounded before forwarding a large body', async t => {
  const upstream = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Length': '100' }); response.end('x'.repeat(100)); });
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await startPublicProxy({ policy: mockPolicy(), maxResponseBytes: 8, request: (options, callback) => http.request({ ...options, hostname: '127.0.0.1', port }, callback) });
  t.after(() => proxy.close());
  const response = await throughProxy(proxy.url, 'http://example.test/');
  assert.equal(response.status, 413);
});

test('active operation limit refuses a second tunnel and close terminates the first', async t => {
  const fixtureSockets = new Set();
  const upstream = net.createServer(socket => { fixtureSockets.add(socket); socket.once('close', () => fixtureSockets.delete(socket)); });
  const port = await listen(upstream);
  t.after(async () => { for (const socket of fixtureSockets) socket.destroy(); await close(upstream); });
  const proxy = await startPublicProxy({ policy: mockPolicy(), maxOperations: 1, connect: () => net.connect({ host: '127.0.0.1', port }) });
  t.after(() => proxy.close());
  function openTunnel() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: new URL(proxy.url).port });
      t.after(() => socket.destroy());
      socket.once('error', reject);
      socket.setTimeout(2000, () => reject(new Error('Capacity test timed out')));
      let data = '';
      socket.on('data', chunk => { data += chunk; if (data.includes('\r\n\r\n')) resolve({ socket, data }); });
      socket.once('connect', () => socket.write('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n'));
    });
  }
  const first = await openTunnel();
  assert.match(first.data, /^HTTP\/1\.1 200/);
  const second = await openTunnel();
  assert.match(second.data, /^HTTP\/1\.1 503 Service Unavailable/);
  const closed = new Promise(resolve => first.socket.once('close', resolve));
  await proxy.close();
  await closed;
  assert.equal(first.socket.destroyed, true);
});
