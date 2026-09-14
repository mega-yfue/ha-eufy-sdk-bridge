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
      EUFY_COUNTRY: "GB" # your account's country code
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

| Env var            | Default                        | Meaning                                                                                                                                                                                                                               |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EUFY_EMAIL`       | — (required)                   | eufy account email                                                                                                                                                                                                                    |
| `EUFY_PASSWORD`    | — (required)                   | eufy account password                                                                                                                                                                                                                 |
| `EUFY_COUNTRY`     | `GB`                           | two-letter account country (routes the region)                                                                                                                                                                                        |
| `BRIDGE_HOST`      | `0.0.0.0`                      | interface the WS/HTTP binds to                                                                                                                                                                                                        |
| `BRIDGE_PORT`      | `3000`                         | WS/HTTP control port                                                                                                                                                                                                                  |
| `EUFY_POLL_MS`     | `600000` (10 min)              | how often the bridge polls the cloud for device state; `0` disables. Also changeable live from the HA integration / the `config.set` WS command                                                                                       |
| `EUFY_SESSION`     | `/app/data/.eufy-session.json` | where the login token is persisted                                                                                                                                 | `SOLIX_EMAIL`      | — (optional)                    | Anker **Solix** account email — enables Solix support (power stations / smart meter). A **separate** account from the eufy one; needs `SOLIX_PASSWORD` too |
| `SOLIX_PASSWORD`   | —                               | Solix account password (enables Solix together with `SOLIX_EMAIL`) |
| `SOLIX_COUNTRY`    | `EUFY_COUNTRY`                  | two-letter Solix account country |
| `SOLIX_SESSION`    | `/app/data/.solix-session.json` | where the Solix login token is persisted |                                                                   |
| `GO2RTC_CONFIG`    | `/app/data/go2rtc.yaml`        | generated from the live device list at startup                                                                                                                                                                                        |
| `GO2RTC_ENABLE`    | `1`                            | set to `0` to keep the bundled go2rtc process disabled                                                                                                                                                                                 |
| `STREAM_IDLE_MS`   | `300000` (5 min)               | auto-off a camera's live P2P feed after this long with no detection event, even if HA still holds the stream "open" — stops the radio to save battery; the next detection reopens it. `0` disables                                    |
| `RTSP_IDLE_OFF_MS` | `300000` (5 min)               | battery-saver: turn a **battery** camera's native `rtspStream` publish OFF after this long idle (no detection, no active bridge stream), so a forgotten `rtspStream=ON` can't drain it. Wired cameras are never touched. `0` disables |
| `BRIDGE_DEBUG`     | off                            | `1` logs each incoming WS command, control-command timing, and P2P connect/close/ack — enough to trace the frontend↔SDK flow                                                                                                          |
| `BRIDGE_DEBUG_P2P` | off                            | `1` additionally routes the SDK's raw per-frame transport logs (very noisy)                                                                                                                                                           |
| `BRIDGE_EVENT_LOG` | **on**                         | prints a `[bridge:event]` line per push/semantic event: what it is, how many frontend clients it reached, and each "Last event" image fetch + result. Narrow (only real events), not the `BRIDGE_DEBUG` firehose. `0` silences        |
| `BRIDGE_SELF_HOST` | `127.0.0.1`                    | host go2rtc uses to pull `/stream/<sn>` back from the bridge                                                                                                                                                                          |
| `BRIDGE_PREWARM`   | off                            | `1` = speculatively open a camera's P2P session on a high-intent event (doorbell/person/pet/package) so a following live view starts instantly. Off by default — it holds a battery camera's radio open ~28s per event                |

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
  (`linux/amd64`, `linux/arm64` — 64-bit ARM like Raspberry Pi / HA OS as well as x86; `node:24-alpine`
  has no 32-bit `arm/v7` base). Republish it with `scripts/publish-multiarch.sh` (see the README).
- **Not host networking?** WebRTC needs UDP/ICE, which is awkward behind bridge networking. If you drop
  `network_mode: host`, publish the ports (`3000`, `1984`, `8554`, `8555/udp`) and expect to sort out
  WebRTC separately; control + snapshots + RTSP still work.
