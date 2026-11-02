import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { connect, type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createPeriscopeProxy, injectScript, relaxCsp, parsePointedBody, proxiedUrl } from '../src/periscope-proxy.ts';
import { INSPECTOR_ROUTE } from '../src/periscope-inspector.ts';
import { readPointedAt } from '../src/periscope-pointed.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) { s.close(); s.closeAllConnections(); } });
const listen = (s: Server) => new Promise<number>((r) => { servers.push(s); s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)); });

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function harness(inject = true) {
  const dev = createServer((req, res) => {
    if (req.url === '/gz') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Security-Policy': "default-src 'none'; img-src data:" });
      res.end(gzipSync('<html><body>zipped</body></html>'));
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: `http://${req.headers.host}/next` });
      res.end();
    } else if (req.url === '/data.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"a":1}');
    } else if (req.url === '/host') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(String(req.headers.host));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '40' });
      res.end('<html><body><p>hi</p></body></html>\n    ');
    }
  });
  // A bare-bones websocket-ish upgrade: answers 101 and echoes what it receives.
  dev.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key']);
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (d) => socket.write(d));
  });
  const devPort = await listen(dev);
  const dir = mkdtempSync(join(tmpdir(), 'crew-proxy-'));
  const dropFile = join(dir, '.crew', 'pointed-at.jsonl');
  const proxy = createPeriscopeProxy({ target: new URL(`http://127.0.0.1:${devPort}`), dropFile, inject, now: () => new Date('2026-11-02T00:00:00Z') });
  const port = await listen(proxy);
  return { port, devPort, dropFile, dir };
}

test('HTML gets the overlay tag before </body>; the overlay script is served by the proxy', async () => {
  const h = await harness();
  const page = await get(h.port, '/');
  assert.match(page.body, new RegExp(`<p>hi</p><script type="module" src="${INSPECTOR_ROUTE}"></script></body>`));
  assert.equal(page.headers['content-length'], String(Buffer.byteLength(page.body)));
  const js = await get(h.port, INSPECTOR_ROUTE);
  assert.equal(js.status, 200);
  assert.match(String(js.headers['content-type']), /javascript/);
  assert.match(js.body, /\/__periscope\/pointed/);
});

test('non-HTML responses and the Host header pass through; the dev server sees its own host', async () => {
  const h = await harness();
  assert.equal((await get(h.port, '/data.json')).body, '{"a":1}');
  assert.equal((await get(h.port, '/host')).body, `127.0.0.1:${h.devPort}`);
});

test('compressed HTML is decompressed for injection and re-sent uncompressed, with the CSP relaxed to the proxy origin', async () => {
  const h = await harness();
  const r = await get(h.port, '/gz', { 'Accept-Encoding': 'gzip' });
  assert.match(r.body, /zipped<script type="module"/);
  assert.equal(r.headers['content-encoding'], undefined);
  assert.equal(r.headers['content-security-policy'], "default-src 'self'; img-src data:");
});

test('a redirect to the dev server\'s own origin is rewritten to the proxy', async () => {
  const h = await harness();
  // The dev server echoes whatever Host it was sent, which the proxy rewrites to the dev server's.
  const r = await get(h.port, '/redirect');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/next');
});

test('a click posts to the pointed route and the proxy appends to the drop file', async () => {
  const h = await harness();
  const ok = await get(h.port, '/__periscope/pointed', { 'Content-Type': 'application/json' }, 'POST',
    JSON.stringify({ path: 'apps/frontend/src/App.tsx', line: 12, component: 'App', url: 'http://x/' }));
  assert.equal(ok.status, 204);
  assert.deepEqual(readPointedAt(h.dir), { path: 'apps/frontend/src/App.tsx', line: 12, component: 'App', url: 'http://x/', at: '2026-11-02T00:00:00.000Z' });
  const bad = await get(h.port, '/__periscope/pointed', {}, 'POST', JSON.stringify({ path: '../etc/passwd', line: 1 }));
  assert.equal(bad.status, 400);
  assert.equal((await get(h.port, '/__periscope/pointed')).status, 405);
  assert.equal(readFileSync(h.dropFile, 'utf8').trim().split('\n').length, 1);
});

test('inject: false is a plain pass-through: no tag, no overlay, no pointed route, CSP untouched', async () => {
  const h = await harness(false);
  const page = await get(h.port, '/');
  assert.doesNotMatch(page.body, /__periscope/);
  const gz = await get(h.port, '/gz');
  assert.equal(gz.headers['content-security-policy'], "default-src 'none'; img-src data:");
  // The dev server has no such route, so the request reaches it and gets its ordinary page.
  const pointed = await get(h.port, '/__periscope/pointed', {}, 'POST', '{"path":"a","line":1}');
  assert.equal(pointed.status, 200);
  assert.equal(existsSync(h.dropFile), false);
});

test('a websocket upgrade is tunnelled to the dev server', async () => {
  const h = await harness();
  const sock = connect({ host: '127.0.0.1', port: h.port });
  const got = await new Promise<string>((resolve, reject) => {
    let buf = '';
    sock.on('error', reject);
    sock.on('connect', () => sock.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n') && !buf.endsWith('ping')) { if (!buf.includes('ping')) sock.write('ping'); }
      if (buf.endsWith('ping')) resolve(buf);
    });
  });
  sock.destroy();
  assert.match(got, /^HTTP\/1\.1 101/);
});

test('a client that disappears abruptly closes the upstream socket too', async () => {
  const dev = createServer();
  const upstreamClosed = new Promise<void>((resolve) => {
    dev.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      // The server's sockets allow half-open, so the peer going away shows as `end` first.
      socket.on('end', () => resolve());
      socket.on('close', () => resolve());
      socket.resume(); // an unread socket never notices the peer going away
    });
  });
  const devPort = await listen(dev);
  const proxy = createPeriscopeProxy({ target: new URL(`http://127.0.0.1:${devPort}`), dropFile: '/nope', inject: false });
  const port = await listen(proxy);
  const sock = connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    sock.on('error', reject);
    sock.on('connect', () => sock.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.once('data', () => resolve());
  });
  sock.destroy();
  await upstreamClosed;
});

test('the request filter can refuse before anything is proxied', async () => {
  const dev = createServer((_q, r) => r.end('secret'));
  const devPort = await listen(dev);
  const proxy = createPeriscopeProxy({
    target: new URL(`http://127.0.0.1:${devPort}`), dropFile: '/nope', inject: true,
    requestFilter: (_req, res) => { if ('writeHead' in res) { res.writeHead(401); res.end(); } return false; },
  });
  const port = await listen(proxy);
  assert.equal((await get(port, '/')).status, 401);
});

test('an unreachable dev server is a 502 that names it', async () => {
  const proxy = createPeriscopeProxy({ target: new URL('http://127.0.0.1:1'), dropFile: '/nope', inject: true });
  const port = await listen(proxy);
  const r = await get(port, '/');
  assert.equal(r.status, 502);
  assert.match(r.body, /not answering/);
});

test('injectScript targets the last </body>, or appends when there is none', () => {
  assert.equal(injectScript('a</BODY>b</body >c').indexOf('<script'), 'a</BODY>b'.length);
  assert.ok(injectScript('<p>no body</p>').endsWith('</script>'));
});

test('relaxCsp adds the proxy origin only where the overlay would be blocked', () => {
  assert.equal(relaxCsp("default-src 'none'; img-src data:"), "default-src 'self'; img-src data:");
  assert.equal(relaxCsp("script-src 'self' https://cdn.x; connect-src ws:"), "script-src 'self' https://cdn.x; connect-src ws: 'self'");
  assert.equal(relaxCsp("img-src *"), 'img-src *');
});

test('parsePointedBody rejects absolute paths, traversal and non-positive lines', () => {
  assert.equal(parsePointedBody('{"path":"/etc/x","line":1}'), null);
  assert.equal(parsePointedBody('{"path":"a/../b","line":1}'), null);
  assert.equal(parsePointedBody('{"path":"a","line":0}'), null);
  assert.equal(parsePointedBody('nope'), null);
  assert.deepEqual(parsePointedBody('{"path":"a.tsx","line":3,"column":2}'), { path: 'a.tsx', line: 3, column: 2 });
});

test('proxiedUrl keeps the dev server\'s path and query on the proxy origin', () => {
  assert.equal(proxiedUrl('http://localhost:40900/', 'localhost', 50900), 'http://localhost:50900/');
  assert.equal(proxiedUrl('http://localhost:40900/app?x=1', '0.0.0.0', 50900), 'http://0.0.0.0:50900/app?x=1');
});
