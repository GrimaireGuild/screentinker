'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-test-'));
process.env.DATA_DIR = dir;
process.env.JWT_SECRET = 'genesis-test-secret-not-for-production';
process.env.SELF_HOSTED = 'true';
const { db } = require('../db/database');
const { bootstrap } = require('../lib/genesis-bootstrap');
const { deviceHealth } = require('../lib/genesis-fleet');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/genesis', require('../routes/genesis'));
app.use('/api/admin', requireAuth, require('../routes/admin'));
app.use('/api/workspaces', requireAuth, require('../routes/workspaces'));
app.use('/api/devices', requireAuth, resolveTenancy, require('../routes/devices'));
let server, base, globalToken, localToken, globalUser, first, second;
const password = 'Testing-only-long-password';
async function call(method, url, token, body) {
  return fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
}

test.before(async () => {
  assert.throws(() => bootstrap(db, 'invalid', password), /valid email/);
  assert.throws(() => bootstrap(db, 'owner@example.test', 'short'), /16 characters/);
  assert.equal(bootstrap(db, 'owner@example.test', password), true);
  globalUser = db.prepare('SELECT * FROM users').get();
  assert.equal(globalUser.must_change_password, 1);
  assert.equal(require('bcryptjs').compareSync(password, globalUser.password_hash), true);
  assert.equal(bootstrap(db, 'different@example.test', 'a-different-password'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(globalUser.id);
  globalToken = generateToken(globalUser);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const customer of ['Store A', 'Restaurant B']) {
    const response = await call('POST', '/api/genesis/locations', globalToken, { name: 'Main Street', customer });
    assert.equal(response.status, 201);
    if (!first) first = await response.json(); else second = await response.json();
  }
  const created = await call('POST', '/api/admin/users', globalToken, {
    name: 'Location admin', email: 'local@example.test', password,
    workspaceId: first.id, role: 'workspace_admin', mustChangePassword: true,
  });
  assert.equal(created.status, 201);
  const local = await created.json();
  assert.equal(local.role, 'user');
  assert.equal(local.must_change_password, 1);
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(local.id);
  localToken = generateToken(local, first.id);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO devices (id, name, workspace_id, user_id, status, last_heartbeat)
    VALUES ('screen-a', 'Menu A', ?, ?, 'online', ?), ('screen-b', 'Private B', ?, ?, 'offline', ?)`)
    .run(first.id, globalUser.id, now, second.id, globalUser.id, now - 400);
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('authentication required; global owner sees every location and offline alert', async () => {
  assert.equal((await call('GET', '/api/genesis/overview')).status, 401);
  const result = await (await call('GET', '/api/genesis/overview', globalToken)).json();
  assert.equal(result.global_admin, true);
  assert.equal(result.totals.locations, 3);
  assert.equal(result.totals.screens, 2);
  assert.equal(result.alerts[0].device_name, 'Private B');
  assert.equal(JSON.stringify(result).includes('password_hash'), false);
});

test('normal admin sees only assigned location, even with forged workspace header/query', async () => {
  const response = await fetch(base + '/api/genesis/overview?workspace_id=' + second.id, {
    headers: { Authorization: `Bearer ${localToken}`, 'X-Workspace-Id': second.id },
  });
  const result = await response.json();
  assert.equal(result.global_admin, false);
  assert.deepEqual(result.locations.map(l => l.id), [first.id]);
  assert.equal(result.alerts.length, 0);
  assert.equal(JSON.stringify(result).includes('Private B'), false);
  assert.equal((await call('GET', '/api/devices/screen-b', localToken)).status, 403);
  assert.equal((await call('GET', '/api/devices/screen-a', localToken)).status, 200);
  assert.equal((await call('POST', '/api/genesis/locations', localToken, { name: 'Unauthorized', customer: 'Bad' })).status, 403);
  assert.equal((await call('POST', `/api/admin/users/${globalUser.id}/workspaces`, localToken, { workspaceId: second.id, role: 'workspace_admin' })).status, 403);
});

test('assign and revoke another location; existing session loses access immediately', async () => {
  const local = db.prepare("SELECT * FROM users WHERE email = 'local@example.test'").get();
  assert.equal((await call('POST', `/api/admin/users/${local.id}/workspaces`, globalToken, { workspaceId: second.id, role: 'workspace_admin' })).status, 201);
  let result = await (await call('GET', '/api/genesis/overview', localToken)).json();
  assert.equal(result.locations.length, 2);
  assert.equal(result.alerts.length, 1);
  assert.equal((await call('DELETE', `/api/admin/users/${local.id}/workspaces/${second.id}`, globalToken)).status, 200);
  result = await (await call('GET', '/api/genesis/overview', localToken)).json();
  assert.deepEqual(result.locations.map(l => l.id), [first.id]);
  assert.equal((await call('GET', '/api/devices/screen-b', localToken)).status, 403);
});

test('health handles stale online status, recovery, missing and stale Wi-Fi data', () => {
  const device = { last_heartbeat: 990, status: 'online' };
  assert.equal(deviceHealth(device, 1000, 90).state, 'online');
  assert.equal(deviceHealth(device, 1100, 90).state, 'offline');
  assert.equal(deviceHealth({ ...device, last_heartbeat: null }, 1000, 90).state, 'pending');
  assert.equal(deviceHealth({ ...device, blocked: 1 }, 1000, 90).state, 'blocked');
  assert.equal(deviceHealth({ ...device, wifi_rssi: -85, reported_at: 999 }, 1000, 90).state, 'degraded');
  assert.equal(deviceHealth({ ...device, wifi_rssi: -85, reported_at: 100 }, 1000, 90).state, 'online');
  assert.equal(deviceHealth({ ...device, wifi_rssi: null, reported_at: 999 }, 1000, 90).state, 'online');
});

test('reject bad provisioning input and preserve existing customer tenancy', async () => {
  assert.equal((await call('POST', '/api/genesis/locations', globalToken, { name: '', customer: 'Test' })).status, 400);
  assert.equal((await call('POST', '/api/genesis/locations', globalToken, { name: 'New', organization_id: 'missing' })).status, 404);
  const response = await call('POST', '/api/genesis/locations', globalToken, { name: 'Second branch', organization_id: first.organization_id });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).organization_id, first.organization_id);
  const result = await (await call('GET', '/api/genesis/overview', localToken)).json();
  assert.deepEqual(result.locations.map(l => l.id), [first.id], 'new sibling location is not automatically visible to a normal admin');
});
