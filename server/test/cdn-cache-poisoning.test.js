'use strict';

// Cloudflare keys its cache on the URL alone. It ignores `Vary` (except for images on paid plans),
// so any response that changes with a request header, or that answers a missing file with a
// success code, can be stored under a URL and served to everyone who asks for it afterwards.
//
// Reproduced on screentinker.com 2026-10-04: one `Accept: text/markdown` fetch of a guide page was
// stored as `public, max-age=900`, and the next ordinary browser request for that URL got raw
// markdown back as a cache HIT. These tests boot the real server and check the headers that decide
// whether a shared cache may keep each kind of answer.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let BASE, proc;
const DATA_DIR = path.join(os.tmpdir(), 'st-cdn-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-cdn-' + crypto.randomBytes(4).toString('hex') + '.log');

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const GUIDE = '/guides/brightsign-digital-signage.html';

// "May a shared cache store this?" — the question Cloudflare answers from Cache-Control.
const sharedCacheable = (cc) => !/\b(private|no-store)\b/i.test(cc || '');

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const get = (p, accept) => fetch(BASE + p, { headers: accept ? { Accept: accept } : {}, redirect: 'manual' });

test('⚠️ markdown negotiated on an HTML URL is never stored by a shared cache', async () => {
  for (const p of [GUIDE, '/']) {
    const r = await get(p, 'text/markdown');
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/markdown/, `${p} still negotiates`);
    const cc = r.headers.get('cache-control');
    assert.ok(!sharedCacheable(cc), `${p}: a markdown reply on the HTML URL must be private/no-store, got "${cc}"`);
  }
});

test('the HTML on the same URL is still what a browser gets, and stays cacheable', async () => {
  const r = await get(GUIDE, BROWSER_ACCEPT);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.ok(sharedCacheable(r.headers.get('cache-control')), 'the page itself must keep its edge caching');
});

test('the .md URL is its own URL, so it keeps public caching', async () => {
  const r = await get(GUIDE.replace(/\.html$/, '.md'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/markdown/);
  assert.match(r.headers.get('cache-control') || '', /public/);
});

test('⚠️ a missing asset is a 404 that is not cached, never the app shell with a 200', async () => {
  for (const p of ['/js/views/does-not-exist.js', '/css/nope.css', '/js/nope.js.map', '/ScreenTinker-missing.apk', '/guides-nope/x.md']) {
    const r = await get(p, '*/*');
    const body = await r.text();
    assert.equal(r.status, 404, `${p} answered ${r.status}`);
    assert.ok(!/<html/i.test(body), `${p} must not return the dashboard HTML`);
    assert.match(r.headers.get('cache-control') || '', /no-store/, `${p}: the miss itself must not be cached`);
  }
});

test('real assets and extensionless app paths are unaffected', async () => {
  const js = await get('/js/app.js', '*/*');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  for (const p of ['/app', '/some/app/route']) {
    const r = await get(p, BROWSER_ACCEPT);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/, `${p} still gets the app shell`);
  }
});
