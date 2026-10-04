'use strict';
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');

function bootstrap(db, email, password) {
  // Never reset credentials or promote an existing account on restart.
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;
  if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email || '')) throw new Error('GENESIS_ADMIN_EMAIL must be a valid email');
  if (typeof password !== 'string' || password.length < 16) throw new Error('GENESIS_ADMIN_PASSWORD must contain at least 16 characters');
  const userId = randomUUID(), orgId = randomUUID(), workspaceId = randomUUID();
  const hash = bcrypt.hashSync(password, 12);
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('telemetry_enabled', 'false')").run();
    db.prepare(`INSERT INTO users (id, email, name, password_hash, role, plan_id, email_verified,
      must_change_password, welcome_email_sent_at, activation_nudge_sent_at)
      VALUES (?, ?, 'Genesis Guild Administrator', ?, 'platform_admin', 'enterprise', 1, 1, strftime('%s','now'), strftime('%s','now'))`)
      .run(userId, email.toLowerCase().trim(), hash);
    db.prepare(`INSERT INTO organizations (id, name, owner_user_id, plan_id) VALUES (?, 'Genesis Guild', ?, 'enterprise')`).run(orgId, userId);
    db.prepare(`INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')`).run(orgId, userId);
    db.prepare(`INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Operations', ?)`).run(workspaceId, orgId, userId);
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')`).run(workspaceId, userId);
  })();
  return true;
}
module.exports = { bootstrap };
