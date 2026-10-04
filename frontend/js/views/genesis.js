import { api } from '../api.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';

let timer;
let generation = 0;
function age(timestamp) {
  if (!timestamp) return 'Never connected';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
async function openLocation(id, deviceId, scheduled = false) {
  try {
    const result = await api.switchWorkspace(id);
    if (!result.token) throw new Error('Location switch failed');
    localStorage.removeItem('st_remote_org');
    localStorage.setItem('token', result.token);
    window.location.hash = deviceId ? `#/device/${encodeURIComponent(deviceId)}` : scheduled ? '#/schedule' : '#/screens';
    window.location.reload();
  } catch (error) { showToast(error.message, 'error'); }
}

export async function render(container) {
  cleanup();
  const current = generation;
  container.innerHTML = `<section class="gg-fleet">
    <header class="gg-heading"><div><div class="gg-eyebrow">GENESIS GUILD / DIGITAL SIGNAGE</div>
      <h1>Your locations. One clear view.</h1><p>Keep every menu, message and promotion connected.</p></div>
      <button class="btn btn-secondary" id="gg-refresh">Refresh status</button></header>
    <div id="gg-error" role="alert"></div><div id="gg-overview" aria-live="polite">Loading your locations…</div>
    <div id="gg-management"></div></section>`;
  const overview = container.querySelector('#gg-overview');
  let initialized = false;
  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const data = await api.get('/genesis/overview');
      if (current !== generation) return;
      container.querySelector('#gg-error').textContent = '';
      const search = overview.querySelector('#gg-search')?.value || '';
      const { totals, locations, alerts } = data;
      overview.innerHTML = `<div class="gg-scope"><span class="gg-dot"></span>${data.global_admin ? 'Global admin · All locations' : 'Assigned locations'}
        <span>Updated ${new Date(data.generated_at * 1000).toLocaleTimeString()} · refreshes every 15s</span></div>
        <div class="gg-stats">${[['Locations', totals.locations], ['Connected screens', totals.online], ['Need attention', totals.attention], ['Total screens', totals.screens]].map(([label, value]) =>
          `<article><span>${label}</span><strong>${value}</strong></article>`).join('')}</div>
        <div class="gg-columns"><section class="gg-panel"><div class="gg-panel-title"><h2>Locations</h2><span>${locations.length} in your view</span></div>
          <label class="gg-search">Find a location<input id="gg-search" type="search" placeholder="Search location or customer" autocomplete="off"></label>
          <div class="gg-locations">${locations.map(location => `<article class="gg-location" data-search="${esc((location.customer + ' ' + location.name).toLowerCase())}">
            <div class="gg-location-top"><div><span class="gg-eyebrow">${esc(location.customer)}</span><h3>${esc(location.name)}</h3></div>
              <span class="gg-pill ${location.attention ? 'warning' : location.devices.length ? 'online' : 'pending'}">${location.attention ? `${location.attention} need attention` : location.devices.length ? 'Connected' : 'No screens paired'}</span></div>
            <p>${location.devices.length} screens · ${location.online} connected</p>
            <div class="gg-screen-list">${location.devices.slice(0, 4).map(device => `<div><span class="gg-dot ${device.state}"></span><span>${esc(device.name)}</span><small>${esc(age(device.last_heartbeat))}</small></div>`).join('')}${location.devices.length > 4 ? `<small>+ ${location.devices.length - 4} more screens</small>` : ''}</div>
            <button class="btn btn-secondary" data-location="${esc(location.id)}">Manage screens & content <span aria-hidden="true">↗</span></button>
            <button class="btn btn-secondary" data-location="${esc(location.id)}" data-schedule="true" style="margin-top:8px">Schedule content changes <span aria-hidden="true">◷</span></button></article>`).join('') || '<div class="gg-empty">No assigned locations yet. A global admin can create your first location or grant access.</div>'}</div>
        </section><aside class="gg-panel"><div class="gg-panel-title"><h2>Connection alerts</h2><span class="gg-pill ${alerts.length ? 'warning' : 'online'}">${alerts.length} active</span></div>
          <p class="gg-note">An alert means a player needs attention. Check its network, power and playback service. Heartbeat timeout: ${data.timeout_seconds}s.</p>
          ${alerts.map(alert => `<button class="gg-alert ${alert.severity}" data-location="${esc(alert.location_id)}" data-device="${esc(alert.device_id)}">
            <span class="gg-eyebrow">${esc(alert.customer)} / ${esc(alert.location_name)}</span><strong>${esc(alert.device_name)}</strong>
            <span>${esc(alert.reason)}</span><small>Last heartbeat: ${esc(age(alert.last_heartbeat))}</small></button>`).join('') || '<div class="gg-empty"><span class="gg-clear">✓</span><h3>No active alerts</h3><p>New connection issues will appear here.</p></div>'}
          <div class="gg-pi"><span class="gg-eyebrow">BUILT FOR YOUR STORES</span><h3>Raspberry Pi players</h3><p>Images and videos, full screen. Pair a Pi from the location’s screen manager.</p><a href="/genesis-pi.html" target="_blank" rel="noopener">Player setup guide ↗</a></div>
        </aside></div>`;
      overview.querySelectorAll('[data-location]').forEach(button => button.onclick = () => openLocation(button.dataset.location, button.dataset.device, button.dataset.schedule === 'true'));
      overview.querySelector('#gg-search').oninput = event => {
        overview.querySelectorAll('[data-search]').forEach(row => row.hidden = !row.dataset.search.includes(event.target.value.toLowerCase()));
      };
      overview.querySelector('#gg-search').value = search;
      overview.querySelectorAll('[data-search]').forEach(row => row.hidden = !row.dataset.search.includes(search.toLowerCase()));
      if (!initialized && data.global_admin) {
        initialized = true;
        management(container.querySelector('#gg-management'), locations, async () => {
          initialized = false;
          await refresh();
        });
      }
    } catch (error) {
      if (current === generation) container.querySelector('#gg-error').textContent = `Status unavailable: ${error.message}. Displayed data may be stale.`;
    } finally { busy = false; }
  }
  container.querySelector('#gg-refresh').onclick = refresh;
  await refresh();
  if (current === generation) timer = setInterval(() => {
    // Preserve focus and typed filters; resume polling as soon as the user leaves the field.
    if (!document.hidden && !container.contains(document.activeElement?.closest('input, select'))) refresh();
  }, 15000);
}

function management(host, locations, refresh) {
  const customers = [...new Map(locations.map(l => [l.organization_id, l.customer])).entries()];
  host.innerHTML = `<section class="gg-panel gg-admin"><div class="gg-panel-title"><h2>Global administration</h2><a href="#/platform/users">All users & permissions ↗</a></div>
    <div class="gg-admin-grid"><form id="gg-location-form"><h3>Add a location</h3>
      <label>Customer<select name="organization_id"><option value="">Create a new customer</option>${customers.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('')}</select></label>
      <label id="gg-customer-field">New customer name<input name="customer" maxlength="120" required placeholder="Restaurant or store group"></label>
      <label>Location name<input name="name" required maxlength="80" placeholder="Downtown · Main Street"></label>
      <button class="btn btn-primary">Create location</button></form>
    <form id="gg-admin-form"><h3>Create a location admin</h3><p>Admins can manage only the locations you assign. Additional assignments and revocation are available in All users & permissions.</p>
      <label>Name<input name="name" required maxlength="120" autocomplete="off"></label>
      <label>Email<input name="email" type="email" required autocomplete="off"></label>
      <label>Temporary password<input name="password" type="password" required minlength="12" autocomplete="new-password"></label>
      <label>Assigned location<select name="workspaceId" required><option value="">Choose a location</option>${locations.map(l => `<option value="${esc(l.id)}">${esc(l.customer)} / ${esc(l.name)}</option>`).join('')}</select></label>
      <button class="btn btn-primary" ${locations.length ? '' : 'disabled'}>Create admin</button><small>Password change required at first sign-in.</small></form></div></section>`;
  const select = host.querySelector('[name="organization_id"]');
  select.onchange = () => {
    host.querySelector('#gg-customer-field').hidden = !!select.value;
    host.querySelector('[name="customer"]').required = !select.value;
  };
  host.querySelectorAll('form').forEach(form => form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      if (form.id === 'gg-location-form') await api.post('/genesis/locations', values);
      else await api.post('/admin/users', { ...values, role: 'workspace_admin', mustChangePassword: true });
      showToast(form.id === 'gg-location-form' ? 'Location created' : 'Location admin created', 'success');
      form.reset();
      await refresh();
    } catch (error) { showToast(error.message, 'error'); }
    finally { button.disabled = false; }
  });
}

export function cleanup() { generation++; clearInterval(timer); }
