'use strict';
(async function () {
  const $ = id => document.getElementById(id);
  const KEY = 'genesis_player_settings_v1';
  const MAX_FILE = 512 * 1024 * 1024;
  const rules = window.GenesisSchedule;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const defaults = { source: 'server', playlistId: 'local-default', imageSeconds: 10, muted: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', autoStart: false, playlists: [{ id: 'local-default', name: 'Local playlist', ids: [] }], schedules: [] };
  let config;
  try { config = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { config = defaults; }
  if (!Array.isArray(config.playlists) || !config.playlists.length) config.playlists = defaults.playlists;
  if (!Array.isArray(config.schedules)) config.schedules = [];
  let media = [], manifest = [], editId = config.playlistId, frameMode = null, playing = false, selectionKey = '', timer, playGeneration = 0, objectUrl, downloader;
  let persistent = false, cacheReady = false, busy = false;
  const identity = () => { try { return JSON.parse(localStorage.getItem('rd_web_player') || '{}'); } catch { return {}; } };
  const notice = (message, error = false) => { $('notice').textContent = message; $('notice').classList.toggle('error', error); };
  const save = () => localStorage.setItem(KEY, JSON.stringify(config));
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('genesis-device-media', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('media', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => { $('setup').hidden = false; notice(`Device storage unavailable: ${error.message}`, true); return null; });
  if (!db) return;
  function storage(method, value) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('media', method === 'getAll' ? 'readonly' : 'readwrite');
      const request = transaction.objectStore('media')[method](...(value === undefined ? [] : [value]));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || new Error('Storage write cancelled; disk may be full'));
    });
  }
  async function updateStorage() {
    const estimate = await navigator.storage?.estimate?.().catch(() => ({})) || {};
    persistent = await navigator.storage?.persisted?.().catch(() => false) || false;
    $('storage-state').textContent = `${media.length} saved files · ${(media.reduce((n, m) => n + m.size, 0) / 1048576).toFixed(1)} MB of media${estimate.quota ? ` · approximately ${Math.max(0, (estimate.quota - estimate.usage) / 1048576).toFixed(0)} MB browser space remaining` : ''}. ${persistent ? 'Persistent storage granted.' : 'Storage can be cleared by the browser; request persistent storage and keep a backup.'} ${cacheReady ? 'Player setup available offline.' : 'Offline startup needs HTTPS (or localhost) and an initial online load.'}`;
  }
  async function persist() {
    await navigator.storage?.persist?.().catch(() => false);
    await updateStorage();
  }
  function mountServer(standby) {
    const mode = standby ? 'standby' : 'play';
    if (frameMode !== mode) {
      $('server-player').src = '/player/?genesis-standby=' + (standby ? '1' : '0');
      frameMode = mode;
    }
    $('server-player').hidden = standby;
  }
  function loadManifest() {
    try { manifest = rules.serverMedia(JSON.parse(localStorage.getItem('rd_playlist_cache') || '[]'), location.origin); } catch { manifest = []; }
    $('download').textContent = `Download assigned server media (${manifest.length})`;
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== $('server-player').contentWindow) return;
    if (event.data?.type === 'genesis-playlist-updated') loadManifest();
    if (event.data?.type === 'genesis-open-setup') requestSetup();
  });
  window.addEventListener('storage', event => { if (event.key === 'rd_playlist_cache') loadManifest(); });
  function readSettings() {
    const seconds = Number($('image-seconds').value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('Image duration must be 1–3600 seconds.');
    const timezone = $('timezone').value.trim();
    try { rules.localTime(new Date(), timezone); } catch { throw new Error('Choose a valid time zone, such as America/Indiana/Indianapolis.'); }
    config.source = $('source').value; config.playlistId = $('default-playlist').value;
    config.imageSeconds = seconds; config.muted = $('muted').checked; config.timezone = timezone;
  }
  function playlistOptions() {
    const options = config.playlists.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
    $('default-playlist').innerHTML = options; $('default-playlist').value = config.playlistId;
    $('edit-playlist').innerHTML = options; $('edit-playlist').value = editId;
    $('schedule-target').innerHTML = '<option value="server">Server-managed content</option>' + config.playlists.map(p => `<option value="${escape(p.id)}">Local · ${escape(p.name)}</option>`).join('');
  }
  function library() {
    const list = config.playlists.find(p => p.id === editId) || config.playlists[0];
    const ordered = [...list.ids.map(id => media.find(m => m.id === id)).filter(Boolean), ...media.filter(m => !list.ids.includes(m.id))];
    $('library').innerHTML = ordered.map(m => `<div class="media-row"><input type="checkbox" aria-label="Include ${escape(m.name)}" data-include="${escape(m.id)}" ${list.ids.includes(m.id) ? 'checked' : ''}><div class="info"><strong>${escape(m.name)}</strong><small>${m.source === 'server' ? 'Downloaded from server' : 'Imported from device'} · ${(m.size / 1048576).toFixed(1)} MB · ${escape(m.type)}</small></div><button data-up="${escape(m.id)}" aria-label="Move ${escape(m.name)} earlier" ${list.ids.indexOf(m.id) <= 0 ? 'disabled' : ''}>↑</button><button data-down="${escape(m.id)}" aria-label="Move ${escape(m.name)} later" ${!list.ids.includes(m.id) || list.ids.indexOf(m.id) === list.ids.length - 1 ? 'disabled' : ''}>↓</button><button data-export="${escape(m.id)}">Export file</button><button data-remove="${escape(m.id)}">Remove copy</button></div>`).join('') || '<p>No files saved yet. Import from this device or download the assigned server playlist.</p>';
    $('library').querySelectorAll('[data-include]').forEach(input => input.onchange = () => {
      list.ids = list.ids.filter(id => id !== input.dataset.include);
      if (input.checked) list.ids.push(input.dataset.include);
      save(); library();
    });
    for (const direction of ['up', 'down']) $('library').querySelectorAll(`[data-${direction}]`).forEach(button => button.onclick = () => {
      const index = list.ids.indexOf(button.dataset[direction]), next = index + (direction === 'up' ? -1 : 1);
      if (index < 0 || next < 0 || next >= list.ids.length) return;
      [list.ids[index], list.ids[next]] = [list.ids[next], list.ids[index]];
      save(); library();
    });
    $('library').querySelectorAll('[data-export]').forEach(button => button.onclick = () => {
      const m = media.find(m => m.id === button.dataset.export), url = URL.createObjectURL(m.blob);
      const a = document.createElement('a'); a.href = url; a.download = m.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    $('library').querySelectorAll('[data-remove]').forEach(button => button.onclick = async () => {
      try {
        await storage('delete', button.dataset.remove);
        media = media.filter(m => m.id !== button.dataset.remove);
        config.playlists.forEach(p => p.ids = p.ids.filter(id => id !== button.dataset.remove));
        save(); library(); await updateStorage(); notice('Device copy removed. The original file is unchanged.');
      } catch (error) { notice(error.message, true); }
    });
  }
  function scheduleList() {
    $('schedule-list').innerHTML = config.schedules.map(rule => `<div class="schedule-row"><div class="info"><strong>${escape(rule.name)}</strong><small>${rule.days.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')} · ${escape(rule.start)}–${escape(rule.end)} · ${rule.source === 'server' ? 'Server-managed' : escape(config.playlists.find(p => p.id === rule.playlistId)?.name || 'Missing playlist')}</small></div><button data-toggle="${escape(rule.id)}">${rule.enabled === false ? 'Enable' : 'Disable'}</button><button data-delete="${escape(rule.id)}">Remove rule</button></div>`).join('') || '<p>No time changes yet. Default playback runs all day.</p>';
    $('schedule-list').querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => { const r = config.schedules.find(r => r.id === b.dataset.toggle); r.enabled = r.enabled === false; save(); scheduleList(); });
    $('schedule-list').querySelectorAll('[data-delete]').forEach(b => b.onclick = () => { config.schedules = config.schedules.filter(r => r.id !== b.dataset.delete); save(); scheduleList(); });
  }
  async function storeMedia(file, source, remoteKey) {
    const type = rules.mediaType(file);
    if (!type) throw new Error(`${file.name}: unsupported file. Use JPEG, PNG, WebP, GIF, AVIF, MP4, WebM or Ogg video.`);
    if (!file.size || file.size > MAX_FILE) throw new Error(`${file.name}: file must be between 1 byte and 512 MB.`);
    const existing = remoteKey && media.find(m => m.remoteKey === remoteKey);
    const list = config.playlists.find(p => p.id === editId) || config.playlists[0];
    if (existing) { if (!list.ids.includes(existing.id)) list.ids.push(existing.id); save(); return; }
    const item = { id: uid(), name: file.name, type, size: file.size, source, remoteKey: remoteKey || null, blob: file };
    // Commit bytes before adding the item to a playlist. A failed write never
    // leaves an apparently downloaded item pointing at missing content.
    await storage('put', item); media.push(item); list.ids.push(item.id); save();
  }
  function setBusy(value) {
    busy = value; $('download').disabled = value; $('import-files').disabled = value;
    $('start').disabled = value; $('pair').disabled = value; $('edit-playlist').disabled = value;
    $('add-playlist').disabled = value;
  }
  async function boundedBlob(response) {
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_FILE) throw new Error('File exceeds the 512 MB download limit.');
        chunks.push(value);
      }
      return new Blob(chunks, { type: response.headers.get('content-type') || '' });
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  $('import-files').onchange = async event => {
    setBusy(true); let imported = 0;
    try {
      await persist();
      for (const file of event.target.files) { notice(`Saving ${file.name} on this device…`); await storeMedia(file, 'local'); imported++; }
      notice(`${imported} files saved on this device and added to the selected playlist.`);
    } catch (error) { notice(`${imported} files saved. ${error.message}`, true); }
    finally { setBusy(false); event.target.value = ''; library(); await updateStorage(); }
  };
  $('download').onclick = async () => {
    loadManifest();
    if (!manifest.length) return notice('No assigned image/video files yet. Pair this player and publish a server playlist first. Webpages and streams cannot be saved as media files.', true);
    if (!identity().paired) return notice('Pair this player before downloading its assigned media.', true);
    setBusy(true); downloader = new AbortController(); $('cancel-download').hidden = false;
    let completed = 0;
    try {
      await persist();
      for (const file of manifest) {
        if (downloader.signal.aborted) throw new Error('Download cancelled. Completed files remain saved.');
        $('download-state').textContent = `Downloading ${completed + 1}/${manifest.length}: ${file.name}`;
        if (!media.some(m => m.remoteKey === file.key)) {
          const response = await fetch(file.url, { signal: downloader.signal });
          if (!response.ok || response.status !== 200) throw new Error(`${file.name}: download failed (${response.status}).`);
          const length = Number(response.headers.get('content-length') || 0);
          if (length > MAX_FILE) throw new Error(`${file.name}: larger than the 512 MB import limit.`);
          const blob = await boundedBlob(response);
          const type = blob.type.split(';')[0];
          if (!rules.mediaType({ type })) throw new Error(`${file.name}: server did not return a supported image or video.`);
          await storeMedia(new File([blob], file.name, { type }), 'server', file.key);
        } else {
          const existing = media.find(m => m.remoteKey === file.key);
          const p = config.playlists.find(p => p.id === editId);
          if (!p.ids.includes(existing.id)) { p.ids.push(existing.id); save(); }
        }
        completed++;
      }
      notice(`${completed} server files saved on this device. Choose a local playlist to play these copies offline.`);
      $('download-state').textContent = `${completed}/${manifest.length} files saved. Server changes require another download; local copies stay as downloaded.`;
    } catch (error) {
      const message = downloader.signal.aborted ? 'Download cancelled. Completed files remain saved.' : error.message;
      notice(message, true); $('download-state').textContent = `${completed} files saved. ${message}`;
    } finally { downloader = null; $('cancel-download').hidden = true; setBusy(false); library(); await updateStorage(); }
  };
  $('cancel-download').onclick = () => downloader?.abort();
  $('persist').onclick = persist;
  $('edit-playlist').onchange = () => { editId = $('edit-playlist').value; library(); };
  $('default-playlist').onchange = () => { config.playlistId = $('default-playlist').value; };
  $('add-playlist').onclick = () => {
    const name = $('playlist-name').value.trim();
    if (!name) return notice('Enter a playlist name.', true);
    const p = { id: uid(), name, ids: [] }; config.playlists.push(p); editId = p.id;
    save(); playlistOptions(); library(); $('playlist-name').value = '';
  };
  $('schedule-form').onsubmit = event => {
    event.preventDefault();
    try {
      readSettings();
      const data = new FormData(event.target), target = data.get('target');
      const rule = { id: uid(), name: data.get('name').trim(), source: target === 'server' ? 'server' : 'local', playlistId: target === 'server' ? '' : target, start: data.get('start'), end: data.get('end'), days: data.getAll('day').map(Number), enabled: true };
      if (!rules.validRule(rule)) throw new Error('Choose at least one day, a playlist, and different start and end times.');
      if (rule.source === 'local' && !config.playlists.find(p => p.id === target)?.ids.length) throw new Error('Add files to that local playlist before scheduling it.');
      config.schedules.push(rule); save(); scheduleList(); notice('Schedule saved on this device.');
    } catch (error) { notice(error.message, true); }
  };
  function stopLocal() {
    playGeneration++; clearTimeout(timer);
    $('local-stage').querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
    $('local-stage').querySelectorAll('img,video').forEach(el => el.remove());
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    $('playback-message').textContent = '';
  }
  function localPlayback(playlistId) {
    stopLocal(); $('local-stage').hidden = false;
    const list = config.playlists.find(p => p.id === playlistId);
    const items = (list?.ids || []).map(id => media.find(m => m.id === id)).filter(Boolean);
    if (!items.length) { $('playback-message').textContent = 'This local playlist has no saved files. Open player setup to import content.'; return; }
    const generation = playGeneration; let index = 0, errors = 0;
    function next() {
      if (generation !== playGeneration) return;
      clearTimeout(timer);
      $('local-stage').querySelectorAll('img,video').forEach(el => { if (el.tagName === 'VIDEO') { el.pause(); el.removeAttribute('src'); el.load(); } el.remove(); });
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const file = items[index++ % items.length], video = file.type.startsWith('video/');
      const element = document.createElement(video ? 'video' : 'img');
      objectUrl = URL.createObjectURL(file.blob); element.src = objectUrl;
      let advanced = false;
      const advance = () => { if (!advanced && generation === playGeneration) { advanced = true; next(); } };
      const failed = () => {
        if (advanced || generation !== playGeneration) return;
        errors++; $('playback-message').textContent = `Cannot play ${file.name}. Use a supported image or H.264 MP4 video.`;
        timer = setTimeout(advance, errors >= items.length ? 10000 : 2000);
      };
      element.onerror = failed;
      if (video) {
        element.autoplay = true; element.playsInline = true; element.muted = config.muted;
        element.onended = advance;
        element.onplaying = () => { clearTimeout(timer); errors = 0; $('playback-message').textContent = ''; };
        element.onwaiting = () => { clearTimeout(timer); timer = setTimeout(failed, 30000); };
        timer = setTimeout(failed, 30000);
        element.play().catch(() => { element.muted = true; element.play().catch(failed); });
      } else {
        element.alt = file.name;
        element.onload = () => { clearTimeout(timer); errors = 0; $('playback-message').textContent = ''; timer = setTimeout(advance, config.imageSeconds * 1000); };
        timer = setTimeout(failed, 15000);
      }
      $('local-stage').appendChild(element);
    }
    next();
  }
  function tick(force = false) {
    let selected;
    try { selected = rules.resolve(config); } catch (error) { notice(`Schedule error: ${error.message}`, true); return; }
    $('current-schedule').textContent = `Now: ${selected.name} · ${new Date().toLocaleString(undefined, { timeZone: config.timezone })} (${config.timezone})`;
    if (!playing) return;
    const key = JSON.stringify([selected.source, selected.playlistId]);
    if (!force && key === selectionKey) return;
    selectionKey = key;
    if (selected.source === 'server') { stopLocal(); $('local-stage').hidden = true; mountServer(false); }
    else {
      if (identity().paired) mountServer(true); else { $('server-player').hidden = true; $('server-player').removeAttribute('src'); frameMode = null; }
      localPlayback(selected.playlistId);
    }
  }
  function showSetup() {
    playing = false; stopLocal(); $('local-stage').hidden = true;
    $('setup').hidden = false; $('source').value = config.source; $('image-seconds').value = config.imageSeconds;
    $('muted').checked = config.muted; $('timezone').value = config.timezone;
    mountServer(true); playlistOptions(); library(); scheduleList(); loadManifest(); updateStorage();
  }
  function requestSetup() {
    const device = identity();
    if (!device.paired) return showSetup();
    $('unlock-error').textContent = device.settingsPin ? '' : 'No settings PIN has been configured. Set one for this display in the admin dashboard first.';
    $('unlock-pin').value = ''; $('unlock').showModal(); $('unlock-pin').focus();
  }
  $('unlock-form').onsubmit = event => {
    event.preventDefault(); const pin = identity().settingsPin;
    if (!pin || $('unlock-pin').value !== String(pin)) { $('unlock-error').textContent = 'Incorrect PIN, or no PIN configured for this display.'; return; }
    $('unlock').close(); showSetup();
  };
  $('cancel-unlock').onclick = () => $('unlock').close();
  $('open-setup').onclick = requestSetup;
  document.addEventListener('keydown', event => { if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') { event.preventDefault(); if ($('setup').hidden && !$('unlock').open) requestSetup(); } });
  $('start').onclick = () => {
    try {
      readSettings();
      if (config.source === 'local' && !config.playlists.find(p => p.id === config.playlistId)?.ids.length) throw new Error('Add at least one file to the default local playlist.');
      config.autoStart = true; save(); $('setup').hidden = true; playing = true; tick(true);
      document.documentElement.requestFullscreen?.().catch(() => {});
    } catch (error) { notice(error.message, true); }
  };
  $('pair').onclick = () => { playing = false; stopLocal(); $('local-stage').hidden = true; $('setup').hidden = true; mountServer(false); };
  media = await storage('getAll');
  if (config.autoStart) { playing = true; $('setup').hidden = true; tick(true); }
  else if (identity().paired) { playing = true; tick(true); }
  else showSetup();
  setInterval(() => tick(), 1000);
  window.addEventListener('pageshow', () => tick(true));
  if ('serviceWorker' in navigator && window.isSecureContext) {
    const assets = ['/player/genesis.html', '/player/genesis-player.js', '/player/genesis-schedule.js', '/player/genesis-player.css'];
    // Registration can fail during an outage even when the installed worker
    // successfully served this page. Report the cache we actually have.
    cacheReady = (await Promise.all(assets.map(url => caches.match(url).catch(() => null)))).every(Boolean);
    updateStorage();
    navigator.serviceWorker.register('/player/sw.js', { scope: '/' }).then(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      // Prime the page and modules only after a worker actually controls us.
      await Promise.all(assets.map(url => fetch(url, { cache: 'reload' }).then(r => { if (!r.ok) throw new Error('Offline setup cache incomplete'); return r.text(); })));
      cacheReady = true; updateStorage();
    }).catch(error => { notice(cacheReady ? 'Server unavailable for player updates. Saved media and cached setup remain available.' : `Offline page setup is not ready: ${error.message}`, !cacheReady); });
  }
})().catch(error => {
  document.getElementById('setup').hidden = false;
  document.getElementById('notice').textContent = `Player setup failed: ${error.message}. Keep this browser profile and reload to try again.`;
});
