'use strict';

/*
 * Smart playlists: a playlist whose items are chosen by rules over the content library (tags,
 * key=value meta, type, folder, name) instead of being added by hand.
 *
 * ⚠️ RESOLVED AT PUBLISH, LIKE NESTING. buildSnapshotItems() asks this module for the matching
 * content and turns it into ordinary snapshot items, so NO PLAYER LEARNS WHAT A RULE IS: offline
 * pinning, the structural fingerprint and every player build keep working unchanged. A screen only
 * ever sees a flat list.
 *
 * Keeping it fresh is the server's job. When content changes, the published smart playlists of that
 * workspace are republished (refreshSmartPlaylists). publishPlaylist() is change-triggered, so a
 * content edit that does not alter a playlist's matches writes nothing and restarts no screen.
 *
 * ⚠️ WORKSPACE-SCOPED, STRICTLY. A rule is a query, and a query that forgot its scope would put
 * another tenant's content on this tenant's screens. Content with workspace_id NULL (legacy rows) is
 * matched only for a playlist that itself has no workspace, and only for the same owner.
 */

const { parseTags, parseMeta } = require('./content-tags');
const { resolveItemDuration } = require('./item-duration');

const FIELDS = ['tag', 'meta', 'type', 'folder', 'name'];
const TYPES = ['image', 'video', 'audio', 'stream', 'youtube', 'web', 'other'];
const SORTS = ['name', 'newest', 'oldest'];
const MAX_RULES = 20;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;
const DEFAULT_IMAGE_SEC = 10;

const OPS = {
  tag:    ['has', 'lacks'],
  meta:   ['eq', 'neq', 'contains', 'exists', 'missing'],
  type:   ['is', 'not'],
  folder: ['in', 'not_in'],
  name:   ['contains', 'not_contains'],
};

function str(v, max) {
  return v == null ? '' : String(v).trim().slice(0, max);
}

/**
 * Validate and canonicalise a rule set. Returns the clean object, null to clear (turn the playlist
 * back into a normal one), or false when it is unusable. A rule set with no rules is refused rather
 * than read as "match everything": dumping a whole library onto lobby screens is the kind of mistake
 * that should take a deliberate rule, not an empty form.
 */
function normalizeRules(v) {
  if (v === null || v === '') return null;
  let obj = v;
  if (typeof v === 'string') { try { obj = JSON.parse(v); } catch { return false; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!Array.isArray(obj.rules) || !obj.rules.length || obj.rules.length > MAX_RULES) return false;

  const rules = [];
  for (const r of obj.rules) {
    if (!r || typeof r !== 'object') return false;
    const field = r.field;
    if (!FIELDS.includes(field)) return false;
    const op = r.op;
    if (!OPS[field].includes(op)) return false;
    const out = { field, op };
    if (field === 'meta') {
      out.key = str(r.key, 40);
      if (!out.key) return false;
      if (op !== 'exists' && op !== 'missing') out.value = str(r.value, 200);
    } else if (field === 'type') {
      out.value = str(r.value, 20).toLowerCase();
      if (!TYPES.includes(out.value)) return false;
    } else if (field === 'tag') {
      out.value = str(r.value, 40).toLowerCase();
      if (!out.value) return false;
    } else {
      out.value = str(r.value, 200);
      if (!out.value) return false;
    }
    rules.push(out);
  }

  const match = obj.match === 'any' ? 'any' : 'all';
  const sort = SORTS.includes(obj.sort) ? obj.sort : 'name';
  let limit = Number(obj.limit);
  limit = Number.isFinite(limit) && limit >= 1 ? Math.min(MAX_LIMIT, Math.floor(limit)) : DEFAULT_LIMIT;
  let imageSec = Number(obj.image_duration);
  imageSec = Number.isFinite(imageSec) && imageSec >= 1 ? Math.min(86400, Math.floor(imageSec)) : DEFAULT_IMAGE_SEC;
  return { match, rules, sort, limit, image_duration: imageSec };
}

function parseRules(raw) {
  if (!raw) return null;
  const n = normalizeRules(raw);
  return n || null;
}

function contentType(c) {
  const m = String(c.mime_type || '').toLowerCase();
  if (m === 'video/youtube') return 'youtube';
  if (m === 'video/hls' || m === 'video/rtsp') return 'stream';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'text/html' || c.bundle_entry) return 'web';
  return 'other';
}

function ruleMatches(rule, c, tags, meta, ctx) {
  switch (rule.field) {
    case 'tag': {
      const has = tags.some((t) => String(t).toLowerCase() === rule.value);
      return rule.op === 'has' ? has : !has;
    }
    case 'meta': {
      const present = Object.prototype.hasOwnProperty.call(meta, rule.key);
      if (rule.op === 'exists') return present;
      if (rule.op === 'missing') return !present;
      const val = present ? String(meta[rule.key]).toLowerCase() : '';
      const want = String(rule.value || '').toLowerCase();
      if (rule.op === 'eq') return present && val === want;
      if (rule.op === 'neq') return !present || val !== want;
      return present && val.includes(want);   // contains
    }
    case 'type': {
      const is = contentType(c) === rule.value;
      return rule.op === 'is' ? is : !is;
    }
    case 'folder': {
      // "In folder X" includes X's subfolders, the way the content library shows them.
      const set = ctx && ctx.folderSets && ctx.folderSets.get(rule.value);
      const inIt = set ? set.has(c.folder_id) : c.folder_id === rule.value;
      return rule.op === 'in' ? inIt : !inIt;
    }
    case 'name': {
      const hit = String(c.filename || '').toLowerCase().includes(String(rule.value).toLowerCase());
      return rule.op === 'contains' ? hit : !hit;
    }
    default:
      return false;
  }
}

/** Does one content row satisfy the rule set? Pure; exported for tests and the editor preview. */
function contentMatches(rules, c, ctx) {
  if (!rules || !rules.rules || !rules.rules.length) return false;
  const tags = parseTags(c.tags);
  const meta = parseMeta(c.meta) || {};
  const results = rules.rules.map((r) => ruleMatches(r, c, tags, meta, ctx));
  return rules.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

function sortRows(rows, sort) {
  const name = (r) => String(r.filename || '');
  const cmp = {
    name:   (a, b) => name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: 'base' }) || String(a.id).localeCompare(String(b.id)),
    newest: (a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0) || String(a.id).localeCompare(String(b.id)),
    oldest: (a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0) || String(a.id).localeCompare(String(b.id)),
  }[sort] || null;
  return cmp ? rows.sort(cmp) : rows;
}

// Each folder a rule names, mapped to itself plus every folder below it.
function folderSetsFor(db, playlist, rules) {
  const wanted = [...new Set(rules.rules.filter((r) => r.field === 'folder').map((r) => r.value))];
  const sets = new Map();
  if (!wanted.length) return sets;
  let rows = [];
  try {
    rows = playlist.workspace_id
      ? db.prepare('SELECT id, parent_id FROM content_folders WHERE workspace_id = ?').all(playlist.workspace_id)
      : [];
  } catch (_) { rows = []; }
  const kids = new Map();
  for (const f of rows) {
    if (!kids.has(f.parent_id)) kids.set(f.parent_id, []);
    kids.get(f.parent_id).push(f.id);
  }
  for (const root of wanted) {
    const set = new Set([root]);
    const stack = [root];
    while (stack.length) {
      for (const k of kids.get(stack.pop()) || []) if (!set.has(k)) { set.add(k); stack.push(k); }
    }
    sets.set(root, set);
  }
  return sets;
}

/**
 * The content rows a playlist's rules select right now: playable (active, unexpired), in the
 * playlist's own workspace, sorted and capped. Returns [] for a playlist without rules.
 */
function matchContent(db, playlist, rulesOverride) {
  const rules = rulesOverride || parseRules(playlist && playlist.smart_rules);
  if (!rules) return [];
  const rows = playlist.workspace_id
    ? db.prepare(`SELECT * FROM content WHERE workspace_id = ?
                    AND COALESCE(is_active, 1) = 1
                    AND (expires_at IS NULL OR expires_at > strftime('%s','now'))`).all(playlist.workspace_id)
    : db.prepare(`SELECT * FROM content WHERE workspace_id IS NULL AND user_id = ?
                    AND COALESCE(is_active, 1) = 1
                    AND (expires_at IS NULL OR expires_at > strftime('%s','now'))`).all(playlist.user_id);
  const ctx = { folderSets: folderSetsFor(db, playlist, rules) };
  const hits = rows.filter((c) => contentMatches(rules, c, ctx));
  return sortRows(hits, rules.sort).slice(0, rules.limit);
}

/**
 * Snapshot items for a smart playlist, the same shape buildSnapshotItems() produces from
 * playlist_items rows, so the rest of the publish path cannot tell the difference.
 */
function snapshotItems(db, playlist) {
  const rules = parseRules(playlist && playlist.smart_rules);
  if (!rules) return [];
  return matchContent(db, playlist, rules).map((c, i) => {
    const it = {
      content_id: c.id,
      widget_id: null,
      child_playlist_id: null,
      zone_id: null,
      sort_order: i,
      // Images get the playlist's image duration; video keeps its own probed length, so a clip is
      // never cut short or left on a black frame.
      duration_sec: contentType(c) === 'image' ? rules.image_duration : resolveItemDuration(null, c),
      muted: 0,
      filename: c.filename,
      mime_type: c.mime_type,
      filepath: c.filepath,
      file_size: c.file_size,
      content_duration: c.duration_sec,
      remote_url: c.remote_url,
      unstable_connection: c.unstable_connection,
      captions_enabled: c.captions_enabled,
      captions_lang: c.captions_lang,
      subtitle_url: c.subtitle_url,
      subtitle_lang: c.subtitle_lang,
      widget_name: null,
      widget_type: null,
      widget_config: null,
      widget_rev: null,
    };
    const tags = parseTags(c.tags);
    if (tags.length) it.tags = tags;
    const meta = parseMeta(c.meta);
    if (meta && Object.keys(meta).length) it.meta = meta;
    return it;
  });
}

/*
 * Republish every PUBLISHED smart playlist in a workspace after its content changed. A draft is left
 * alone: its owner is mid-edit and has not chosen to put anything live. Debounced per workspace so a
 * 50-file upload republishes once, not 50 times.
 */
const pending = new Map();
const DEBOUNCE_MS = 1500;

// ⚠️ LOCAL ROWS ONLY. A workspace copied from another node (scale-out) is the primary's to publish;
// a replica that republished it would fight the primary's snapshot on every sweep.
function refreshNow(db, publish, workspaceId) {
  const { LOCAL_ROWS_SQL } = require('./replica-proxy');
  const base = `SELECT id, workspace_id FROM playlists p WHERE p.smart_rules IS NOT NULL AND p.status = 'published' AND ${LOCAL_ROWS_SQL('p')}`;
  const rows = workspaceId
    ? db.prepare(`${base} AND p.workspace_id = ?`).all(workspaceId)
    : db.prepare(base).all();
  let changed = 0;
  // ⚠️ An approval-gated workspace publishes only what someone approved. Auto-refresh would put
  // newly matching content live past that gate, so there the playlist waits for a normal release.
  const policy = require('./release-policy');
  const gated = new Map();
  for (const r of rows) {
    if (!gated.has(r.workspace_id)) gated.set(r.workspace_id, !!(r.workspace_id && policy.approvalRequired(db, r.workspace_id)));
    if (gated.get(r.workspace_id)) continue;
    try { if (publish(r.id).changed) changed++; } catch (e) { console.warn(`[smart-playlist] refresh ${r.id} failed: ${e && e.message}`); }
  }
  return { checked: rows.length, changed };
}

function scheduleRefresh(db, publish, workspaceId) {
  const key = workspaceId || '*';
  if (pending.has(key)) return;
  const t = setTimeout(() => {
    pending.delete(key);
    try { refreshNow(db, publish, workspaceId); } catch (e) { console.warn(`[smart-playlist] refresh failed: ${e && e.message}`); }
  }, DEBOUNCE_MS);
  if (t.unref) t.unref();
  pending.set(key, t);
}

// Wiring for the live server: server.js hands over the socket server once, and every content write
// path calls notifyContentChanged(workspaceId). Both are no-ops until start() has run (tests, CLI).
let liveIo = null;
let started = false;

function defaultPublish(id) {
  return require('../routes/playlists').publishPlaylist(id, liveIo);
}

function notifyContentChanged(workspaceId) {
  if (!started) return;
  try { scheduleRefresh(require('../db/database').db, defaultPublish, workspaceId || null); } catch (_) { /* never fail a content write */ }
}

const SWEEP_MS = 5 * 60 * 1000;
function start(io) {
  liveIo = io || null;
  if (started) return;
  started = true;
  // Backstop for a write path that forgot to notify (an import, a mesh sync, a direct DB fix-up).
  // publishPlaylist is change-triggered, so a sweep that finds nothing new writes nothing.
  const t = setInterval(() => {
    try { refreshNow(require('../db/database').db, defaultPublish, null); } catch (e) { console.warn(`[smart-playlist] sweep failed: ${e && e.message}`); }
  }, SWEEP_MS);
  if (t.unref) t.unref();
}

module.exports = {
  normalizeRules, parseRules, contentMatches, contentType, matchContent, snapshotItems,
  refreshNow, scheduleRefresh, notifyContentChanged, start, FIELDS, TYPES, OPS, MAX_LIMIT,
};
