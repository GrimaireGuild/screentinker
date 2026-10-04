# Genesis Guild Digital Signage

Genesis Guild edition of [ScreenTinker](https://github.com/screentinker/screentinker), based on version 2.3.2, upstream commit `83d7049dbf5199d33ee6546ca6a74596e4b917cc`. The original MIT license and copyright notice are retained in `LICENSE`. The masked-man logo is the existing Genesis Guild business-card artwork displayed through an SVG viewport. The charcoal, violet and lavender palette follows the Genesis Guild website.

## Open the local installation

Open <http://localhost:3001/app>. The initial global administrator is **doom@genesis-guild.com**. Its generated temporary password is in `secrets/admin-password.txt` (excluded from Git and Docker build context). Change it at first sign-in. The bootstrap never resets passwords or promotes existing users on subsequent starts.

To start again on this computer:

```powershell
cd 'C:\Users\Denaro\Documents\GG Digital Signage\screentinker\server'
npm run start:genesis
```

Node 24 or later is recommended. `server/.env` contains local configuration; `.genesis-data` contains this local instance's database and media. No sample customer data is inserted into it. Operations is the initial empty internal location.

## Roles and locations

| Product term | Stored permission | Access |
| --- | --- | --- |
| Global admin | `platform_admin` | All customers, locations, users and settings |
| Location admin | `user` plus `workspace_admin` membership | Only assigned locations, including their screens, media and playlists |
| Customer | Organization | Groups a restaurant or retail customer's locations |
| Location | Workspace | Isolated media, screens, schedules and memberships |

From **Locations & alerts**, create a customer and its first location, or select an existing customer when adding a branch. Create an admin with a temporary password and select their first location. **All users & permissions → Workspaces** on that user manages additional assignments and removes access. Each assignment is checked on the server. A new sibling location does not automatically become visible to a location admin.

Do not grant customer admins `platform_operator`, `platform_admin`, `org_admin` or `org_owner`: these upstream roles intentionally have broader access. The dedicated Create a location admin form always creates the restricted role. Public registration is disabled.

**Manage screens & content** switches to the selected location before opening its display manager. Pair devices there, upload media in Content, create a playlist, assign it, and publish. The original scheduling, video, image, layout and playlist capabilities remain available.

## Monitoring

The overview refreshes every 15 seconds while the tab is visible and no form field is focused. The configured heartbeat timeout is 90 seconds. It shows:

- Unreachable players, using last heartbeat and connection status. Power loss and stopped players can cause this as well as network outages.
- Weak Wi-Fi when the device reports a fresh RSSI of -75 dBm or lower. Chromium players may not expose Wi-Fi telemetry; absence does not imply healthy Wi-Fi.
- Blocked players and players awaiting their first heartbeat.

Alerts disappear automatically when the condition clears. The overview is live status, not an incident acknowledgement system. Upstream device history remains available in each screen's details. Email delivery requires configuring your own SMTP or Graph transport; no outgoing email account has been configured.

## Docker server

Install Docker Engine with Compose on the server, or Docker Desktop for local testing. Run from the repository root:

```sh
cp .env.genesis.example .env
docker compose up -d --build
docker compose logs -f signage
```

On PowerShell, use `Copy-Item .env.genesis.example .env` instead of `cp` if preferred. On this computer, the bootstrap secret already exists. For a different host, create a private `secrets` directory and `secrets/admin-password.txt` containing a unique password of at least 16 characters before starting Compose. Transfer only this secret through a secure channel. The image does not contain it.

The service runs as the non-root `node` user, drops Linux capabilities, rotates logs, has a health check and restarts automatically. Its named volume stores database, uploads and generated JWT signing secret. Initial credential setup happens before the web server listens. The container serves the admin dashboard at `/` and `/app`, and Genesis Guild player setup at `/player/genesis.html`. The original server player remains at `/player`. The image installs FFmpeg for video thumbnails and duration detection.

Default binding is **127.0.0.1:3001**, suitable for a reverse proxy. For stores, set `APP_URL` to your actual HTTPS signage domain and configure a TLS reverse proxy to port 3001 with WebSocket support. For private LAN testing only, set `GENESIS_BIND_ADDRESS=0.0.0.0` and use the host's LAN address. A Pi cannot reach your server through the Pi's own `localhost`. Never disable certificate checking on players.

The local development database and Docker named volume are separate. Starting Docker creates its own fresh instance with the same bootstrap email; it does not import local records automatically. Stop the local Node server before using Docker on the same port, or choose another `GENESIS_PORT`. Back up `/data` with the service stopped or using the existing backup tools; do not copy only a live SQLite main file while ignoring its WAL. Do not use `docker compose down -v` unless you intend to delete the instance's data.

`SELF_HOSTED=true` enables features without upstream subscription limits. This delivery does not configure a payment processor, collect payments, or implement per-customer license-key enforcement. You can manage commercial customer agreements separately; the platform's existing plan/billing features need your own configuration before selling automated subscriptions.

## Raspberry Pi OS player

Recommended target: Pi 4 or Pi 5, 64-bit Raspberry Pi OS Bookworm, Desktop or Lite. Use Ethernet where available. On the Pi, copy the `scripts` folder from this checkout, then run:

```sh
sudo bash scripts/genesis-pi-setup.sh https://YOUR-SIGNAGE-HOST
sudo reboot
```

Use your real server origin. The wrapper validates the URL and invokes the checked-in installer in **player-only** mode: the Docker server manages the fleet; the Pi runs Chromium kiosk playback. It does not clone or install a management server on the Pi. Desktop uses login autostart with a restart loop; enable desktop autologin. Lite uses `screentinker-kiosk.service`. Keep its browser profile to retain pairing and cached media.

At boot, the Genesis Guild player opens its source and schedule setup. Choose **Open server player / pairing**, then enter the Pi's pairing code in the selected location's Add Display dialog. Set that display's **settings PIN** in the admin dashboard before returning to setup. Upload JPEG/PNG images and H.264 MP4 videos, create and publish a playlist, and verify playback. For Lite diagnostics:

```sh
sudo systemctl status screentinker-kiosk
sudo journalctl -u screentinker-kiosk -n 100
```

Desktop kiosk logs are in `~/screentinker-kiosk.log`. Use trusted HTTPS so the browser can cache media with a service worker. Wait for the full playlist to download before testing offline playback. External webpages and live streams still need their network source. Test cold boot, power interruption, HDMI resolution, video/audio decoding and network loss on the actual Pi before shipping to a customer.

## Local files, server downloads and timed changes

On each Pi, open `/player/genesis.html`. Use the gear or **Ctrl+Shift+S** to reopen setup. Paired displays require their settings PIN; the PIN protects the local setup controls, not the operating system against someone with physical access.

1. **Import from this device:** select a local playlist, then Import images & videos. The file picker can select files from the Pi's disk or a mounted USB drive. Files are copied into the browser's device storage; they are not uploaded. Disconnect USB only after import finishes. Use the checkboxes and arrows to select files and their order.
2. **Play from the server:** select Server-managed images & videos as the default source. Pair the display, assign a published playlist in its location, and the server player handles playback and its normal offline cache.
3. **Download server files:** while paired and online, choose a local playlist and Download assigned server media. Assigned image/video files are saved in the device library, with progress and cancellation. Choose a local source to play these saved copies. Repeat the download after publishing changed server media; saved copies do not change automatically. This downloads the currently delivered assignment, not every file or future scheduled playlist on the server.
4. **Schedule changes:** create local playlists such as Breakfast and Dinner. In Change content at a set time, choose the display time zone, days, start/end time, and either a local playlist or server-managed content. Add each rule, then Save & start playback. Outside a rule, the default source resumes. Overnight rules belong to their start day; the newest matching rule wins an overlap. These rules and local files survive reloads and work offline after the player shell has been cached. Keep the Pi clock correct.
5. **Schedule remotely:** from Locations & alerts choose Schedule content changes for the location. The existing server calendar schedules published content for displays/groups. Local device rules take precedence while a local playlist is active. Server calendar updates need a server connection; use downloaded local playlists and device rules for predictable offline daypart changes.

Save & start playback persists startup preferences for subsequent kiosk launches. Videos play to completion; images use the configured duration. A source/time change interrupts the current item. The player skips files it cannot decode and displays an error if necessary. H.264 MP4 is the deployment target; verify codecs on the actual Pi. Local import/download permits JPEG, PNG, WebP, GIF, AVIF, MP4, WebM and Ogg video, up to **512 MB per file**, subject to available browser storage and codec support. SVG, HTML, webpages and live streams are not imported as local media.

Use **Keep files on this device** to request persistent storage. The browser may refuse; the storage status reports the result. Keep the same server origin and Chromium profile. Clearing site data or changing the server address makes the old library unavailable. **Export file** saves a normal downloadable file for backup; **Remove copy** removes only the device library copy. The browser does not automatically scan folders or write back to the original USB files. Local libraries, source settings and device rules are configured at each player; the dashboard manages server playlists and the server calendar.

## Validation and current limits

All 160 targeted tests passed on October 4, 2026. They cover initial admin creation, location creation, server-side visibility, cross-location denial, membership grant/revocation, alert health classification, local schedule boundaries/overnight/DST/overlap rules, media filtering and URL restrictions, plus upstream permission, branding, frontend API, player cache, server schedule and Pi installer regressions. A live login check confirmed the real admin must change its temporary password before accessing the dashboard. Browser verification confirmed global/location-admin views, local image and MP4 import/playback, server image download, persisted playlists, PIN-gated setup and scheduled local playback after stopping the sample server and reloading. The MP4 test used the [MDN video example](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video); it is test data only and is not bundled. Compose YAML parsing, JavaScript syntax and Bash syntax checks passed. The previews in `docs/genesis-dashboard-preview.png` and `docs/genesis-player-preview.png` contain sample data, not live customer data.

Docker build/run and real Raspberry Pi playback have not been tested on this computer: Docker and Pi hardware are unavailable. FFmpeg is included in the container but is not installed on this Windows host, so local video thumbnails/duration extraction are unavailable until it is installed. Actual media playback and fleet deployment require your host/domain and devices.
