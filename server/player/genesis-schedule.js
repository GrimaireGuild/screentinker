(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GenesisSchedule = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function minute(value) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')) return null;
    const [h, m] = value.split(':').map(Number);
    return h * 60 + m;
  }
  function validRule(rule) {
    return !!rule && ['local', 'server'].includes(rule.source)
      && (rule.source === 'server' || typeof rule.playlistId === 'string' && !!rule.playlistId)
      && Array.isArray(rule.days) && rule.days.length > 0
      && rule.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
      && minute(rule.start) !== null && minute(rule.end) !== null && rule.start !== rule.end;
  }
  function localTime(now, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday), minute: Number(values.hour) * 60 + Number(values.minute) };
  }
  function active(rule, now, timezone) {
    if (!validRule(rule) || rule.enabled === false) return false;
    const time = localTime(now, timezone), start = minute(rule.start), end = minute(rule.end);
    if (start < end) return rule.days.includes(time.day) && time.minute >= start && time.minute < end;
    // An overnight window belongs to the day on which it STARTS.
    return time.minute >= start ? rule.days.includes(time.day)
      : time.minute < end && rule.days.includes((time.day + 6) % 7);
  }
  function resolve(config, now = new Date()) {
    // Newest matching rule wins. Outside every rule, return to the default.
    const rule = [...(config.schedules || [])].reverse().find(r => active(r, now, config.timezone));
    return rule ? { source: rule.source, playlistId: rule.playlistId || '', ruleId: rule.id, name: rule.name }
      : { source: config.source || 'server', playlistId: config.playlistId || '', ruleId: null, name: 'Default playback' };
  }
  function mediaType(file) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm', 'video/ogg'];
    if (allowed.includes(file.type)) return file.type;
    if (file.type) return null;
    const ext = String(file.name || '').split('.').pop().toLowerCase();
    return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg' })[ext] || null;
  }
  function serverMedia(items, origin) {
    const found = new Map();
    for (const item of items || []) {
      if (!item || !item.filepath || item.remote_url || !mediaType({ type: item.mime_type })) continue;
      const filepath = String(item.filepath);
      if (/[\\?#]/.test(filepath) || filepath.split('/').some(part => part === '..' || part === '.')) continue;
      const url = new URL('/uploads/content/' + filepath.split('/').map(encodeURIComponent).join('/'), origin);
      if (item.content_rev) url.searchParams.set('rev', String(item.content_rev));
      found.set(url.href, { key: url.href, url: url.href, name: item.filename || filepath.split('/').pop(), type: item.mime_type });
    }
    return [...found.values()];
  }
  return { minute, validRule, localTime, active, resolve, mediaType, serverMedia };
});
