'use strict';

// A location is an existing workspace: media, devices, sockets and memberships
// retain the same tenant boundary as the rest of ScreenTinker.
function visibleLocations(db, user, globalAdmin) {
  return db.prepare(`SELECT w.id, w.name, w.organization_id, o.name AS customer
    FROM workspaces w JOIN organizations o ON o.id = w.organization_id
    WHERE ? = 1 OR EXISTS (SELECT 1 FROM workspace_members m
      WHERE m.workspace_id = w.id AND m.user_id = ?)
      OR EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = w.organization_id
        AND m.user_id = ? AND m.role IN ('org_owner', 'org_admin'))
    ORDER BY o.name COLLATE NOCASE, w.name COLLATE NOCASE`).all(globalAdmin ? 1 : 0, user.id, user.id);
}

function deviceHealth(device, now, timeoutSeconds) {
  if (device.blocked) return { state: 'blocked', reason: 'Player blocked by an administrator', severity: 'warning' };
  if (!device.last_heartbeat) return { state: 'pending', reason: 'Waiting for first heartbeat', severity: 'warning' };
  const age = Math.max(0, now - device.last_heartbeat);
  if (age > timeoutSeconds || device.status === 'offline') {
    return { state: 'offline', reason: 'Player unreachable — check power, network and kiosk service', severity: 'critical' };
  }
  // Old telemetry must not keep raising Wi-Fi warnings after recovery. Browser
  // players may not report RSSI at all; absence is not a healthy Wi-Fi reading.
  if (device.reported_at && now - device.reported_at <= 300 && device.wifi_rssi != null && device.wifi_rssi <= -75) {
    return { state: 'degraded', reason: `Weak Wi-Fi signal (${device.wifi_rssi} dBm)`, severity: 'warning' };
  }
  return { state: 'online', reason: 'Heartbeat received', severity: null };
}

function fleetOverview(db, user, globalAdmin, timeoutSeconds, now = Math.floor(Date.now() / 1000)) {
  const locations = visibleLocations(db, user, globalAdmin);
  const devicesQuery = db.prepare(`SELECT d.id, d.name, d.status, d.blocked, d.last_heartbeat,
    d.ip_address, d.app_version, t.wifi_rssi, t.reported_at
    FROM devices d LEFT JOIN device_telemetry t ON t.id = (
      SELECT id FROM device_telemetry WHERE device_id = d.id ORDER BY reported_at DESC, id DESC LIMIT 1)
    WHERE d.workspace_id = ? ORDER BY d.name COLLATE NOCASE`);
  const alerts = [];
  const totals = { locations: locations.length, screens: 0, online: 0, attention: 0 };
  for (const location of locations) {
    location.devices = devicesQuery.all(location.id).map(device => {
      const health = deviceHealth(device, now, timeoutSeconds);
      if (health.severity) alerts.push({ ...health, device_id: device.id, device_name: device.name,
        location_id: location.id, location_name: location.name, customer: location.customer,
        last_heartbeat: device.last_heartbeat });
      return { ...device, ...health };
    });
    location.online = location.devices.filter(d => d.state === 'online').length;
    location.attention = location.devices.length - location.online;
    totals.screens += location.devices.length;
    totals.online += location.online;
    totals.attention += location.attention;
  }
  alerts.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1)
    || (a.last_heartbeat || 0) - (b.last_heartbeat || 0));
  return { global_admin: globalAdmin, generated_at: now, timeout_seconds: timeoutSeconds, totals, locations, alerts };
}

module.exports = { visibleLocations, deviceHealth, fleetOverview };
