'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('../player/genesis-schedule');
const breakfast = { id: 'breakfast', name: 'Breakfast', source: 'local', playlistId: 'breakfast-media', days: [1,2,3,4,5], start: '07:00', end: '11:00', enabled: true };
const config = { source: 'server', playlistId: 'fallback', timezone: 'America/Indiana/Indianapolis', schedules: [breakfast] };

test('local playback changes on precise start/end boundaries and falls back outside the window', () => {
  assert.equal(schedule.resolve(config, new Date('2026-10-05T10:59:59Z')).source, 'server');
  assert.equal(schedule.resolve(config, new Date('2026-10-05T11:00:00Z')).playlistId, 'breakfast-media');
  assert.equal(schedule.resolve(config, new Date('2026-10-05T14:59:59Z')).playlistId, 'breakfast-media');
  assert.equal(schedule.resolve(config, new Date('2026-10-05T15:00:00Z')).source, 'server');
});
test('weekday filters exclude the weekend', () => {
  assert.equal(schedule.resolve(config, new Date('2026-10-04T12:00:00Z')).source, 'server');
});
test('overnight schedules belong to their starting day, including Sunday rollover', () => {
  const r = { ...breakfast, days: [0], start: '22:00', end: '02:00' };
  assert.equal(schedule.active(r, new Date('2026-10-05T05:59:59Z'), config.timezone), true);
  assert.equal(schedule.active(r, new Date('2026-10-05T06:00:00Z'), config.timezone), false);
  assert.equal(schedule.active(r, new Date('2026-10-04T05:00:00Z'), config.timezone), false);
});
test('local wall-clock schedules follow daylight saving time', () => {
  assert.equal(schedule.resolve(config, new Date('2026-10-30T11:00:00Z')).playlistId, 'breakfast-media');
  assert.equal(schedule.resolve(config, new Date('2026-11-02T11:00:00Z')).source, 'server');
  assert.equal(schedule.resolve(config, new Date('2026-11-02T12:00:00Z')).playlistId, 'breakfast-media');
});
test('newest overlapping enabled rule wins; disabling it restores the earlier rule', () => {
  const override = { ...breakfast, id: 'override', source: 'server' };
  const cfg = { ...config, schedules: [breakfast, override] };
  assert.equal(schedule.resolve(cfg, new Date('2026-10-05T12:00:00Z')).ruleId, 'override');
  override.enabled = false;
  assert.equal(schedule.resolve(cfg, new Date('2026-10-05T12:00:00Z')).ruleId, 'breakfast');
});
test('invalid rules are excluded; invalid timezone is not silently interpreted in another timezone', () => {
  for (const value of [{ days: [] }, { start: '25:00' }, { end: '7:00' }, { end: '07:00' }, { source: 'unknown' }, { days: [7] }, { playlistId: '' }]) {
    assert.equal(schedule.validRule({ ...breakfast, ...value }), false);
  }
  assert.throws(() => schedule.localTime(new Date(), 'not-a-zone'), RangeError);
});
test('only known image/video formats can enter local playback', () => {
  assert.equal(schedule.mediaType({ type: '', name: 'MENU.MP4' }), 'video/mp4');
  assert.equal(schedule.mediaType({ type: 'image/png' }), 'image/png');
  assert.equal(schedule.mediaType({ type: 'text/html', name: 'menu.png' }), null);
  assert.equal(schedule.mediaType({ type: 'image/svg+xml', name: 'menu.svg' }), null);
  assert.equal(schedule.mediaType({ type: '', name: 'script.exe' }), null);
});
test('download manifest is same-origin, revision-aware and rejects external or unsafe paths', () => {
  const item = { filepath: 'menu board.png', filename: '<Menu>', mime_type: 'image/png', content_rev: 2 };
  const result = schedule.serverMedia([item, item, { ...item, filepath: '../secret.png' }, { ...item, filepath: 'x?token=a' }, { ...item, remote_url: 'https://external.test/a.png' }, { filepath: 'index.html', mime_type: 'text/html' }], 'https://signage.example');
  assert.equal(result.length, 1);
  assert.equal(result[0].url, 'https://signage.example/uploads/content/menu%20board.png?rev=2');
  assert.equal(result[0].name, '<Menu>');
});
