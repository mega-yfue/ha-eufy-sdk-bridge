# Running the bridge with Docker Compose

The bridge is one container that logs into eufy **once** and exposes the SDK over a WebSocket (+ HTTP
video) for the [`ha-eufy-sdk`](https://github.com/mega-yfue/ha-eufy-sdk) Home Assistant integration.
The published image already bundles the SDK and go2rtc, so you don't build anything — you pull and run.

- **Image:** `ghcr.io/mega-yfue/ha-eufy-sdk-bridge:latest` (multi-arch: `amd64` · `arm64`)
- **Ports:** `3000` WS/HTTP control · `1984` go2rtc API/WebRTC · `8554` RTSP · `8555` WebRTC (TCP/UDP)

> **One session per account.** eufy allows a single active login per account, so run **exactly one**
> bridge, and expect opening the phone app to bump the bridge's session (and vice-versa). The `data`
> volume persists the login so a restart doesn't re-authenticate.

---

## Option A — run it alongside Home Assistant (recommended)

Add this service to the same `docker-compose.yaml` you run Home Assistant from:

```yaml
services:
  # ... your existing homeassistant service ...

  eufy-bridge:
    image: ghcr.io/mega-yfue/ha-eufy-sdk-bridge:latest
    container_name: eufy-bridge
    restart: unless-stopped
    network_mode: host # needed for go2rtc WebRTC (UDP/ICE)
    environment:
      EUFY_EMAIL: "you@example.com"
      EUFY_PASSWORD: "your-password"
      EUFY_COUNTRY: "GB" # the country the account was signed up in
      BRIDGE_HOST: "0.0.0.0" # bind all interfaces
      BRIDGE_PORT: "3000" # change the WS/control port here if 3000 is taken
    volumes:
      - /opt/homeassistant/eufy-bridge-data:/app/data # persists the login token
```

Start just the bridge:

```bash
docker compose up -d eufy-bridge
docker compose logs -f eufy-bridge
```

Because HA and the bridge share the host network, point the integration at **`localhost`** (or the
server's LAN IP) and the port you set.

---

## Option B — standalone (bridge on its own host)

`docker-compose.yaml`:

```yaml
services:
  eufy-bridge:
    image: ghcr.io/mega-yfue/ha-eufy-sdk-bridge:latest
    container_name: eufy-bridge
    restart: unless-stopped
    network_mode: host
    env_file: .env
    environment:
      BRIDGE_HOST: "0.0.0.0"
    volumes:
      - ./data:/app/data
```

`.env` (next to the compose file):

```dotenv
EUFY_EMAIL=you@example.com
EUFY_PASSWORD=your-password
EUFY_COUNTRY=GB
BRIDGE_PORT=3000
```

```bash
docker compose up -d
```

Point the integration at this host's IP and `BRIDGE_PORT`.

---

## Configuration reference

| Env var                            | Default                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EUFY_EMAIL`                       | — (required)                    | eufy account email                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EUFY_PASSWORD`                    | — (required)                    | eufy account password                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `EUFY_COUNTRY`                     | `GB`                            | two-letter country the account was registered in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `BRIDGE_HOST`                      | `0.0.0.0`                       | interface the WS/HTTP binds to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `BRIDGE_PORT`                      | `3000`                          | WS/HTTP control port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `EUFY_POLL_MS`                     | `600000` (10 min)               | how often the bridge polls the cloud for device state; `0` disables. Also changeable live from the HA integration / the `config.set` WS command                                                                                                                                                                                                                                                                                                                                                                                                    |
| `EUFY_SESSION`                     | `/app/data/.eufy-session.json`  | where the login token is persisted (the FCM push registration is persisted beside it as `.eufy-fcm.json`, so restarts reconnect instead of re-registering)                                                                                                                                                                                                                                                                                                                                                                                         |
| `BRIDGE_OPENUDID`                  | — (derived from email)          | distinct per-install device identity. Leave unset for a single bridge. Set a **unique** value per bridge if you run more than one on the same account — otherwise they share an identity and displace each other's session / split push delivery                                                                                                                                                                                                                                                                                                   |
| `SOLIX_EMAIL`                      | — (optional)                    | Anker **Solix** account email — enables Solix support (power stations / smart meter). A **separate** account from the eufy one; needs `SOLIX_PASSWORD` too                                                                                                                                                                                                                                                                                                                                                                                         |
| `SOLIX_PASSWORD`                   | —                               | Solix account password (enables Solix together with `SOLIX_EMAIL`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SOLIX_COUNTRY`                    | `EUFY_COUNTRY`                  | two-letter Solix account country                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SOLIX_SESSION`                    | `/app/data/.solix-session.json` | where the Solix login token is persisted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SOLIX_SCENE_POLL_MS`              | `90000` (90 s)                  | how often the Solix scene backstop poll runs — the slow authed read that fills the gap fields (battery temperature + a SOC cross-check) the realtime MQTT push doesn't carry. Kept slow on purpose: Anker throttles frequent reads                                                                                                                                                                                                                                                                                                                 |
| `SOLIX_RETRY_BASE_MS`              | `900000` (15 min)               | starting delay for the Solix login self-heal backoff after a failed login — doubles per consecutive failure, capped at `SOLIX_RETRY_MAX_MS`. Kept well past the login-throttle window; Anker throttles frequent logins and can escalate to a captcha                                                                                                                                                                                                                                                                                               |
| `SOLIX_RETRY_MAX_MS`               | `3600000` (1 h)                 | cap for the escalating Solix login-retry backoff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GO2RTC_CONFIG`                    | `/app/data/go2rtc.yaml`         | generated from the live device list at startup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GO2RTC_ENABLE`                    | **on**                          | `0` disables spawning the bundled go2rtc process (e.g. using the one from Frigate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `STREAM_IDLE_MS`                   | `300000` (5 min)                | auto-off a camera's live P2P feed after this long with no detection event, even if HA still holds the stream "open" — stops the radio to save battery; the next detection reopens it. `0` disables                                                                                                                                                                                                                                                                                                                                                 |
| `SNAPSHOT_LIVE`                    | `auto`                          | how `/snapshot/<sn>` (the still HA shows on a camera tile) gets its picture. `auto`: a **mains** camera gets a fresh live burst; a **battery** camera answers from disk and is not woken: from its last-event thumbnail or the last frame of a stream someone watched, whichever is newer, because HA re-fetches stills on a timer and each live burst is a radio wake. `1` forces the live burst for every camera, `0` never takes one. When no live still is taken or it fails, the persisted last-event thumbnail is served instead of an error |
| `RTSP_IDLE_OFF_MS`                 | `300000` (5 min)                | battery-saver: turn a **battery** camera's native `rtspStream` publish OFF after this long idle (no detection, no active bridge stream), so a forgotten `rtspStream=ON` can't drain it. Wired cameras are never touched. `0` disables                                                                                                                                                                                                                                                                                                              |
| `STREAM_FAIL_BACKOFF_MS`           | `30000` (30 s)                  | battery-saver: after a live-stream open **fails** (P2P connect timeout / no P2P endpoint), refuse to reopen that camera for this window — doubling per consecutive failure, capped at 5 min — so go2rtc's ~30 s ffmpeg retries return a fast 503 instead of waking the camera radio on every retry. Cleared by a successful open or a detection. `0` disables                                                                                                                                                                                      |
| `STREAM_BATTERY_BUDGET_MS`         | SDK default (`45000`)           | how long a **battery** camera may stream continuously. The SDK stops a battery live session after this budget plus a 10 s grace unless it is extended, and `/stream` cannot extend it, so with the default a watched stream drops every ~55 s and the reconnect wakes the camera again. Raise it (e.g. `180000`) to keep a watched stream up. Mains cameras ignore it; closing the last viewer still ends the session immediately, and `STREAM_IDLE_MS` still applies                                                                              |
| `EVENT_IMAGE_REFRESH_MAX_MS`       | `240000` (4 min)                | on a **local-storage** HomeBase the event thumbnail ("Last event") is written some time after the motion push, so after a detection the bridge re-queries the cover on an escalating schedule up to this cap until a genuinely-new image lands. Raise it if your HomeBase writes crops slowly                                                                                                                                                                                                                                                      |
| `EVENT_IMAGE_AUTOHEAL_COOLDOWN_MS` | `60000` (60 s)                  | if the window above expired before the crop was ready, the next time HA fetches the (stale) "Last event" the bridge re-attempts the cover **in the background** — the same thing the _Refresh Last Event_ button does — so the image self-heals without a button press. Throttled to at most one attempt per device per this interval so HA's image polling can't churn the P2P session. `0` disables the auto-heal                                                                                                                                |
| `BRIDGE_DEBUG`                     | off                             | `1` logs each incoming WS command, control-command timing, and P2P connect/close/ack — enough to trace the frontend↔SDK flow                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `BRIDGE_DEBUG_P2P`                 | off                             | `1` additionally routes the SDK's raw per-frame transport logs (very noisy)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BRIDGE_EVENT_LOG`                 | **on**                          | prints a `[bridge:event]` line per push/semantic event: what it is, how many frontend clients it reached, and each "Last event" image fetch + result. Narrow (only real events), not the `BRIDGE_DEBUG` firehose. `0` silences                                                                                                                                                                                                                                                                                                                     |
| `BRIDGE_STREAM_CONSUMER_LOG_MS`    | `15000` (15 s)                  | when a camera stream is requested, log its **immediate** requester (IP + user-agent — normally go2rtc's own ffmpeg) and then ask go2rtc who the real **consumer** is (an HA card, a recording, a WebRTC/HLS client — with its address/protocol), throttled to one probe per camera per this interval. Use it to trace a stream that keeps opening "by itself". `0` disables the go2rtc probe (the immediate-requester line still logs, under `BRIDGE_EVENT_LOG`)                                                                                   |
| `BRIDGE_SELF_HOST`                 | `127.0.0.1`                     | host go2rtc uses to pull `/stream/<sn>` back from the bridge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `BRIDGE_PREWARM`                   | off                             | `1` = speculatively open a camera's P2P session on a high-intent event (doorbell/person/pet/package) so a following live view starts instantly. Off by default — it holds a battery camera's radio open ~28s per event                                                                                                                                                                                                                                                                                                                             |

---

## First run: 2FA / captcha

On the first login eufy usually requires **2FA** (or a captcha). The bridge does **not** exit on this —
it stays up and reports the auth state over the WS, so you resolve it one of two ways:

- **From the Home Assistant integration (recommended).** Add the `ha-eufy-sdk` integration, enter the
  bridge host + port, and it walks you through the 2FA/captcha steps in the UI.
- **From the CLI** (from a checkout of this repo): `node scripts/login.mjs ws://HOST:PORT/ws` — it
  prompts for the code, or writes the captcha to `captcha.png` for you to solve.

Once authenticated, the token is saved in the `data` volume and restarts won't re-prompt.

---

## Verify it's up

```bash
curl -s http://HOST:PORT/healthz          # {"ok":true,"auth":{"state":"ok"},...}
node scripts/devices.mjs ws://HOST:PORT/ws # lists your devices (from a repo checkout)
```

See [`ws-protocol.md`](./ws-protocol.md) for the full WebSocket protocol.

---

## Notes

- **Architecture:** the published `ghcr.io/mega-yfue/ha-eufy-sdk-bridge` image is a multi-arch manifest
  (`linux/amd64`, `linux/arm64`), so it runs on 64-bit Raspberry Pi / HA OS on ARM as well as
  x86. Republish it with `scripts/publish-multiarch.sh` (see the repo README's deploy note).
- **Not host networking?** WebRTC needs UDP/ICE, which is awkward behind bridge networking. If you drop
  `network_mode: host`, publish the ports (`3000`, `1984`, `8554`, `8555/udp`) and expect to sort out
  WebRTC separately; control + snapshots + RTSP still work.
