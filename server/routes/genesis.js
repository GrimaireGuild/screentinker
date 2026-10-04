'use strict';
const router = require('express').Router();
const { randomUUID } = require('crypto');
const { db } = require('../db/database');
const { requireAuth, requirePlatformAdmin, isPlatformRole } = require('../middleware/auth');
const { fleetOverview } = require('../lib/genesis-fleet');
const { logActivity, getClientIp } = require('../services/activity');
const config = require('../config');

router.use(requireAuth);
router.get('/overview', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(fleetOverview(db, req.user, isPlatformRole(req.user.role), config.heartbeatTimeout / 1000));
});

// Global admins provision locations. Regular admins are granted explicit
// workspace_admin memberships; they never receive organization-wide access.
router.post('/locations', requirePlatformAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const customer = String(req.body?.customer || '').trim();
  const organizationId = String(req.body?.organization_id || '').trim();
  if (!name || name.length > 80 || (!organizationId && (!customer || customer.length > 120))) {
    return res.status(400).json({ error: 'Location name (1–80 characters) and customer (1–120 characters) required' });
  }
  if (organizationId && !db.prepare('SELECT id FROM organizations WHERE id = ?').get(organizationId)) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  if (organizationId && db.prepare('SELECT 1 FROM workspaces WHERE organization_id = ? AND origin_node_id IS NOT NULL').get(organizationId)) {
    return res.status(409).json({ error: 'Manage this customer on its primary server' });
  }
  const id = randomUUID();
  const orgId = organizationId || randomUUID();
  db.transaction(() => {
    if (!organizationId) {
      db.prepare(`INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status)
        VALUES (?, ?, ?, 'enterprise', 'active')`).run(orgId, customer, req.user.id);
      db.prepare(`INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')`).run(orgId, req.user.id);
    }
    db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)').run(id, orgId, name, req.user.id);
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
      VALUES (?, ?, 'workspace_admin', ?)`).run(id, req.user.id, req.user.id);
  })();
  logActivity(req.user.id, 'genesis_create_location', `location: ${name}`, null, getClientIp(req), id);
  res.status(201).json({ id, name, organization_id: orgId });
});

module.exports = router;
