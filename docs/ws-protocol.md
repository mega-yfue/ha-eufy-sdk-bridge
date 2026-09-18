# ha-eufy-sdk-bridge — WebSocket protocol

The bridge exposes control, state, auth and events over one WebSocket, and video/snapshots over sibling
HTTP endpoints. This is the reference for what a frontend (the HACS integration, a web UI, anything)
sends and receives.

- **Endpoint:** `ws://<host>:3000/ws`
- **Schema version:** `1` (sent in `hello`/`ready`; bumped on any breaking change so an old client fails loudly)
- **Encoding:** JSON text frames.

## Message shapes

**Request** (client → bridge): a `cmd` plus a caller-chosen `id` used to match the reply.

```json
{ "id": 1, "cmd": "<command>", "...": "command args" }
```

**Response** (bridge → client): echoes `id`, with `ok`.

```json
{ "id": 1, "ok": true,  "...": "result fields" }
{ "id": 1, "ok": false, "error": "reason" }
```

**Event** (bridge → client, unsolicited): no `id`, carries an `event` name.

```json
{ "event": "<name>", "...": "payload" }
```

---

## Commands

### `auth.status`
Ask what the login needs right now.

```jsonc
// →
{ "id": 1, "cmd": "auth.status" }
// ←
{ "id": 1, "ok": true, "auth": { "state": "ok" } }
```

`auth` is one of:

| state | extra fields | meaning |
| --- | --- | --- |
| `ok` | — | logged in; device commands work |
| `require_2fa` | `method` | a 2FA code was sent; submit it |
| `require_captcha` | `image` (`data:image/png;base64,…`), `retry` (bool) | solve the captcha image |
| `pending` | — | no challenge yet / retrying |
| `reauth` | — | the cloud session was kicked/expired **after** startup (another login on the account, or a token timeout); the bridge is re-logging in automatically. It becomes `ok` on success, or `require_2fa` if a fresh code is needed — drive `auth.submit` then |

The bridge pushes an unsolicited `auth` event (same fields as `auth.status`'s `auth` object) whenever this
state changes, so a frontend re-renders the challenge without polling. A single active session per account
means a login elsewhere (e.g. opening the phone app) bumps the bridge into `reauth`; it recovers on its own
unless the account then demands a 2FA code.

### `auth.submit`
Submit a 2FA code **or** a captcha answer. The pending id/token is held inside the bridge.

```jsonc
// 2FA:
{ "id": 2, "cmd": "auth.submit", "code": "123456" }
// captcha:
{ "id": 2, "cmd": "auth.submit", "captcha": "AB3D" }
// ←  (the new auth state after the attempt)
{ "id": 2, "ok": true, "auth": { "state": "ok" } }
// missing both →
{ "id": 2, "ok": false, "error": "auth.submit needs { code } (2FA) or { captcha } (captcha answer)" }
```

### `auth.retrigger`
Request a fresh challenge (new captcha image / new 2FA code).

```jsonc
// →
{ "id": 3, "cmd": "auth.retrigger" }
// ←
{ "id": 3, "ok": true, "auth": { "state": "require_captcha", "image": "data:image/png;base64,…", "retry": false } }
```

### `devices.list`
Every device the account exposes. *(Requires `auth.state == "ok"`.)*

```jsonc
// →
{ "id": 4, "cmd": "devices.list" }
// ←
{
  "id": 4, "ok": true,
  "devices": [
    {
      "sn": "EXAMPLE-CAM-0001",
      "name": "Living Room Camera",
      "model": "T8410",
      "modelName": "Indoor Cam Pan & Tilt",
      "codec": "camera",
      "capabilities": ["video","snapshot","motion","camera","rtsp","battery","light","ptz","audio","info"],
      "state": { "battery": 74, "motion": false, "light": true, "statusLed": true },
      "stream": "/stream/EXAMPLE-CAM-0001"
    },
    { "sn": "EXAMPLE-SENSOR-0002", "name": "Entry Sensor", "model": "T8900",
      "modelName": "Entry Sensor", "codec": "sensor",
      "capabilities": ["contact","battery","info"],
      "state": { "contact": true, "battery": 88 } }
  ]
}
```

- `name` is the owner's device name (from `device_name`); it falls back to `modelName` when the device is unnamed.
- `model` is the T-code (e.g. `T8410`); `modelName` is the product display name (e.g. `Indoor Cam Pan & Tilt`).
- `state` is a flat `{ property: value }` map of the device's **current** values; reading it schedules a background refresh, and semantic events (below) push changes between reads.
- `stream` is present only on devices with live video (cameras/doorbells).
- `streaming` (cameras/doorbells only) is `true` while a live P2P feed is actually open right now — the
  same signal the `streamState` event carries, so a frontend can seed a "Streaming" sensor from the list.
- `canReboot` is `true` on HomeBase/station devices, which accept `device.reboot`.
- A device that failed to resolve appears as `{ "sn": "…", "error": "…" }`.

### `device.state`
The same shape as one `devices.list` entry, for a single device (identity + capabilities + live `state`). *(Requires auth.)*

```jsonc
// →
{ "id": 5, "cmd": "device.state", "sn": "EXAMPLE-CAM-0001" }
// ←
{ "id": 5, "ok": true, "device": { "sn": "…", "name": "…", "codec": "camera", "capabilities": ["…"], "state": { "battery": 74, … }, "stream": "/stream/…" } }
```

### `device.properties`
The device's **property manifest** — one entry per property, with enough metadata for a frontend to
build the right entity without knowing eufy wire ids. Static per device; fetch once at setup.
*(Requires auth.)*

```jsonc
// →
{ "id": 9, "cmd": "device.properties", "sn": "EXAMPLE-CAM-0001" }
// ←
{
  "id": 9, "ok": true, "sn": "EXAMPLE-CAM-0001",
  "properties": [
    { "name": "battery",   "type": "number", "unit": "%",   "kind": "percent", "writable": false },
    { "name": "statusLed", "type": "bool",                                       "writable": true  },
    { "name": "motion",    "type": "bool",                                       "writable": false },
    { "name": "workingMode","type": "enum",  "writable": true,
      "enumValues": { "0": "Optimal battery life", "1": "Optimal surveillance", "2": "Custom" } }
  ]
}
```

Map an entry to an entity: `writable` + `bool` → **switch**, `enum` → **select** (`enumValues` = raw→label),
`number` → **number** (`unit`/`kind` for display), everything else → **sensor**. Pair with the live value
from `state` (same `name`).

### `device.set`
Write a property (maps to the SDK's `setProperty`). The valid `name`s are the writable properties a
device's capabilities expose (e.g. `statusLed`, `nightVision`, guard-mode `mode`, …). *(Requires auth.)*

```jsonc
// →
{ "id": 6, "cmd": "device.set", "sn": "EXAMPLE-CAM-0001", "name": "statusLed", "value": true }
// ←
{ "id": 6, "ok": true }
// unsupported property / device →
{ "id": 6, "ok": false, "error": "device … does not support 'statusLed'" }
```

### `device.action`
Invoke a capability **action** — a typed method that isn't a scalar writable property, so `device.set`
can't reach it. `args` is the positional argument list (omitted = none). Only methods the SDK's own
capability surfaces expose are reachable; today those are `smart_light`, `camera` and `ptz`.
*(Requires auth.)*

A **dotted** `action` walks a sub-API namespace: every segment before the last one hands back a
namespace without acting (so it takes no arguments), and only the final segment receives `args`.
`preset.goto` is therefore `dev.ptz().preset().goto(id)`.

```jsonc
// one pan-tilt step — the four verbs are `left` / `right` / `up` / `down`, all no-arg →
{ "id": 7, "cmd": "device.action", "sn": "EXAMPLE-CAM-0001", "action": "left" }
// ←
{ "id": 7, "ok": true, "result": null }

// move to stored preset 3 →
{ "id": 8, "cmd": "device.action", "sn": "EXAMPLE-CAM-0001", "action": "preset.goto", "args": [3] }
// save the camera's current position into preset 3 →
{ "id": 9, "cmd": "device.action", "sn": "EXAMPLE-CAM-0001", "action": "preset.save", "args": [3] }

// a verb no surface carries →
{ "id": 10, "ok": false, "error": "no action 'calibrate' on EXAMPLE-CAM-0001" }
```

PTZ movement is **fire-and-forget**: P2P sends no acknowledgement, so `ok: true` means the frame left
for the camera, not that it finished moving. Where the camera ended up arrives separately as a
`ptzNotify` event. The preset write verbs are fire-and-forget the same way, and referencing an **empty
slot is a silent no-op** — `goto`/`save`/`delete` on an unpopulated id do nothing and report no error.
Only cameras whose `capabilities` include `ptz` carry these verbs; asking a fixed camera fails with
`no action`.

### `device.reboot`
Reboot a **HomeBase / station** (maps to the SDK's `reboot`). Only devices with `canReboot: true` accept
it; the SDK throws for a non-hub serial. The hub drops offline for a minute or two, then rejoins.
*(Requires auth.)*

```jsonc
// →
{ "id": 7, "cmd": "device.reboot", "sn": "EXAMPLE-STATION-0003" }
// ←
{ "id": 7, "ok": true }
// non-hub serial →
{ "id": 7, "ok": false, "error": "…" }
```

### `event.refresh`
Force an immediate **"Last event" image** refresh for a device — pull the newest event cover from the
HomeBase now and (if a genuinely newer image landed) broadcast `eventImageUpdated`. Backs a manual
"Refresh Last Event" control; useful when the automatic on-detection refresh raced the HomeBase writing
the crop. *(Requires auth.)*

```jsonc
// →  { "id": 8, "cmd": "event.refresh", "sn": "EXAMPLE-CAM-0001" }
// ←  { "id": 8, "ok": true, "changed": true }   // changed=false when no newer image is available yet
```

### `config.get` / `config.set`
Read or change the **cloud poll interval** (`pollMs`, milliseconds) at runtime — how often the bridge
re-reads device state from the cloud. `0` disables polling. Unset at startup → the SDK default
(600000 = 10 min); the `EUFY_POLL_MS` env var sets the startup value. *(Requires auth.)*

```jsonc
// →  { "id": 9, "cmd": "config.get" }
// ←  { "id": 9, "ok": true, "pollMs": 600000 }

// →  { "id": 10, "cmd": "config.set", "pollMs": 120000 }   // poll every 2 min
// ←  { "id": 10, "ok": true, "pollMs": 120000 }
// invalid →
{ "id": 10, "ok": false, "error": "pollMs must be a non-negative number (ms)" }
```

Faster polling means fresher state but more cloud traffic; the cloud itself only refreshes these
values on the order of minutes, so intervals below ~1 min mostly add load without adding freshness.

### `stream.start`
Returns the URLs for a camera's live video. **Does not open the camera** — connecting to the URL is
what starts it; disconnecting stops it. *(Requires auth.)*

```jsonc
// →
{ "id": 7, "cmd": "stream.start", "sn": "EXAMPLE-CAM-0001" }
// ←
{
  "id": 7, "ok": true,
  "path": "/stream/EXAMPLE-CAM-0001",
  "http": "http://127.0.0.1:3000/stream/EXAMPLE-CAM-0001",
  "rtsp": "rtsp://127.0.0.1:8554/EXAMPLE-CAM-0001"
}
```

### `stream.stop`
Advisory only — the media connection closing is the real "stop". *(Requires auth.)*

```jsonc
// →  { "id": 8, "cmd": "stream.stop", "sn": "…" }
// ←  { "id": 8, "ok": true }
```

### Anker Solix (`solix.*`)
Optional — present only when the bridge has `SOLIX_EMAIL` / `SOLIX_PASSWORD` set. Solix is a **separate
Anker account** on a separate backend, so these commands do **not** require the eufy `auth.state == "ok"`
and are independent of the eufy device commands above.

#### `solix.status`
```jsonc
// →  { "id": 9, "cmd": "solix.status" }
// ←  { "id": 9, "ok": true, "solix": { "enabled": true, "state": "ready", "deviceCount": 1 } }
```
`state`: `disabled` | `connecting` | `2fa` | `ready` | `error`. `enabled` is `false` when `SOLIX_*` is unset.

#### `solix.devices`
The account's Solix devices (empty until `state == "ready"`). *(Not gated by eufy auth.)*
```jsonc
// →  { "id": 10, "cmd": "solix.devices" }
// ←  { "id": 10, "ok": true, "devices": [ {
//       "source": "solix", "sn": "…", "productCode": "AE1X0", "name": "Smart Meter Gen 2",
//       "category": "Accessory",
//       "capabilities": ["identity", "firmware", "connectivity", "energyMeter"],
//       "firmware": "V1.0.0.9", "online": true, "ssid": "Xman24", "rssi": -35,
//       "values": { "gridVoltage": 237.1 } } ] }
```

#### `solix.submitCode`
Complete a pending Solix 2FA (only when `state == "2fa"`). The code is never logged.
```jsonc
// →  { "id": 11, "cmd": "solix.submitCode", "code": "123456" }
// ←  { "id": 11, "ok": true, "solix": { "enabled": true, "state": "ready", "deviceCount": 1 } }
```

### Errors
- Unknown command → `{ "id": n, "ok": false, "error": "unknown cmd: …" }`
- A device command before auth → `{ "id": n, "ok": false, "error": "not authenticated — query auth.status and complete 2FA/captcha first" }`
- Malformed frame → `{ "ok": false, "error": "bad json" }` (no `id`)

---

## Events (unsolicited)

### Lifecycle
| event | payload | when |
| --- | --- | --- |
| `hello` | `{ schemaVersion, auth: { state, … } }` | on connect |
| `auth` | `{ state, image?, method?, retry? }` | auth state changed |
| `ready` | `{ schemaVersion }` | login complete + devices/go2rtc up |

```json
{ "event": "hello", "schemaVersion": 1, "auth": { "state": "ok" } }
{ "event": "auth", "state": "require_2fa", "method": "email" }
{ "event": "ready", "schemaVersion": 1 }
```

### Device events (forwarded from the SDK, broadcast to all clients)
Each carries the SDK's event payload (typically `deviceSn` / `stationSn` plus event-specific fields).

```json
{ "event": "motion", "deviceSn": "EXAMPLE-CAM…", "stationSn": "EXAMPLE-HB…" }
{ "event": "contactState", "deviceSn": "EXAMPLE-SENSOR…", "open": true }
{ "event": "batteryLevel", "deviceSn": "EXAMPLE-CAM…", "to": "74" }
{ "event": "doorbellPress", "deviceSn": "EXAMPLE-DOORBELL…" }
```

Full set: `motion`, `personDetected`, `strangerDetected`, `doorbellPress`, `petDetection`,
`packageDelivered`, `packageTaken`, `packageStranded`, `soundDetected`, `cryingDetected`,
`vehicleDetected`, `dogDetected`, `armingModeChanged`, `alarm`, `lockState`, `contactState`,
`batteryLevel`, `batteryAlert`, `ptzNotify`, `smartLightState`.

### Anker Solix events
Present only when Solix is configured (`SOLIX_*`).

| event | payload | when |
| --- | --- | --- |
| `solixAuth` | `{ state, method?, error? }` | Solix login state changed (incl. `state: "2fa"`) |
| `solixReady` | `{ devices: [...] }` | Solix devices discovered (same shape as `solix.devices`) |
| `solixReading` | `{ deviceSn, productCode, values }` | a live telemetry frame |

```json
{ "event": "solixReading", "deviceSn": "…", "productCode": "AE1X0", "values": { "gridVoltage": 237.1 } }
```

Plus a stream-lifecycle event (not a device push):

```json
{ "event": "streamState", "deviceSn": "EXAMPLE-CAM…", "active": true }
```

Fired when a camera's live P2P feed opens (`active: true`) or is torn down / idle-suspended
(`active: false`). The device summary also carries the current value as a `streaming` boolean.

---

## Sibling HTTP endpoints

| method + path | returns |
| --- | --- |
| `GET /healthz` | `{ ok, schemaVersion, auth: { state }, streaming: [sn,…] }` — always available (even before auth) |
| `GET /snapshot/<sn>` | a JPEG still (`image/jpeg`). *Requires auth.* |
| `GET /stream/<sn>` | live Annex-B H.264/H.265 (`video/H264`) — what go2rtc pulls. *Requires auth.* |

go2rtc (bundled) turns `/stream/<sn>` into RTSP / WebRTC / MSE / HLS, so the frontend never speaks the
raw video protocol.

---

## Not yet exposed
- Capability **action** verbs beyond the `smart_light` / `camera` / `ptz` surfaces `device.action`
  routes today (e.g. siren test, talkback).
- PTZ **zoom** (`zoom`) and the preset **read** verbs (`preset.list` / `preset.image`): both exist on
  the SDK surface and `device.action` would route them, but zoom needs a second telephoto lens and the
  read verbs answer over P2P request/reply, so neither is exercised here yet.
- Raw P2P command ids that the SDK never promotes to a capability member — pan **calibration**
  (`CMD_INDOOR_PAN_CALIBRATION` 6017 / `CMD_OUTDOOR_PAN_CALIBRATION` 6251) is the notable one.
- Guard / station security mode (arm home/away/disarm).
- Per-device event subscription/filtering (events broadcast to all clients).
- Audio / recording / timelapse.
