// Environment → the immutable config + constants the whole bridge reads. Side-effect free (no mkdir,
// no process.exit) so it can be imported from tests; server.mjs owns the startup guards.
import path from "node:path";

export const SCHEMA_VERSION = 1; // bump on any breaking protocol change so an old frontend fails loudly

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ""));

/** The SDK event names broadcast to every connected WS client. */
export const FORWARDED_EVENTS = [
  "motion", "personDetected", "strangerDetected", "doorbellPress", "petDetection",
  "packageDelivered", "packageTaken", "packageStranded", "soundDetected", "cryingDetected",
  "vehicleDetected", "dogDetected", "armingModeChanged", "alarm", "lockState",
  "contactState", "batteryLevel", "batteryAlert", "ptzNotify", "smartLightState",
];

// The "something happened" pushes (not battery/arming/state changes) — these keep a camera's live
// feed warm and reset the battery rtspStream idle clock (see stream-idle.mjs).
export const DETECTION_EVENTS = new Set([
  "motion", "personDetected", "strangerDetected", "petDetection", "vehicleDetected", "dogDetected",
  "doorbellPress", "packageDelivered", "packageTaken", "packageStranded", "soundDetected", "cryingDetected",
]);

export const PUSH_STALL_MS = 5 * 60_000;   // push down (or never up) this long ⇒ events are dead ⇒ recover
export const SUSPEND_RELEASE_MS = 30_000;  // no /stream pull this long while suspended ⇒ nobody's watching
export const STREAM_FAIL_BACKOFF_MAX_MS = 5 * 60_000; // cap on the exponential backoff after failed opens

/**
 * Parse the environment into the config + derived constants. `dbg` is a no-op unless BRIDGE_DEBUG is on.
 * BRIDGE_DEBUG=1 logs each WS command + control timing + P2P lifecycle; BRIDGE_DEBUG_P2P=1 additionally
 * routes the SDK's raw per-frame ConsoleLogger (very noisy).
 */
export function loadConfig(env = process.env) {
  const cfg = {
    email: env.EUFY_EMAIL,
    password: env.EUFY_PASSWORD,
    country: env.EUFY_COUNTRY || "GB",
    host: env.BRIDGE_HOST || "0.0.0.0",
    port: Number(env.BRIDGE_PORT || 3000),
    session: env.EUFY_SESSION || "./data/.eufy-session.json",
    // Distinct per-install device identity. Unset → the SDK derives one from the account email, which is
    // STABLE but IDENTICAL for every client on the account — so a second client (a second bridge, or the
    // phone app under some conditions) presents the same identity and the two displace each other's
    // session / split push delivery. Set a unique value per bridge when you run more than one on an account.
    openudid: env.BRIDGE_OPENUDID || undefined,
    go2rtcConfig: env.GO2RTC_CONFIG || "./go2rtc.yaml",
    // Toggle for the bundled go2rtc process. Useful when running go2rtc as a separate container/service
    // instead of the one bundled here. Default ON to match existing behavior; set GO2RTC_ENABLE=0 to skip
    // spawning it.
    go2rtcEnable: env.GO2RTC_ENABLE == null ? true : truthy(env.GO2RTC_ENABLE),
    selfHost: env.BRIDGE_SELF_HOST || "127.0.0.1",
    // Cloud poll interval (ms). Unset → the SDK default (600000 = 10 min). Changeable live via the
    // config.set WS command. 0 disables polling.
    pollMs: env.EUFY_POLL_MS ? Number(env.EUFY_POLL_MS) : undefined,
    // Auto-off a live stream after this many ms with no detection event. A battery camera bleeds power
    // while its P2P live session is up, and go2rtc holds /stream open as long as anything consumes it —
    // so keep the feed only while detections are recent. Default 5 min; 0 disables.
    streamIdleMs: env.STREAM_IDLE_MS != null ? Number(env.STREAM_IDLE_MS) : 300_000,
    // Battery-saver: a BATTERY camera left with the device's native `rtspStream` publish ON encodes
    // continuously and drains, even when nobody consumes it. If a battery device has rtspStream=true and
    // has been idle this long, turn rtspStream OFF on the device. Default 5 min; 0 disables.
    rtspIdleOffMs: env.RTSP_IDLE_OFF_MS != null ? Number(env.RTSP_IDLE_OFF_MS) : 300_000,
    // Battery-saver: when a /stream open FAILS (P2P connect timeout, no p2p_did, connection closed), go2rtc's
    // ffmpeg source keeps retrying into /stream every ~30s — and each retry opens a fresh P2P session,
    // waking the camera radio for nothing on a camera that can't connect. After a failure, refuse reopening
    // for this base window (doubling per consecutive failure, capped at STREAM_FAIL_BACKOFF_MAX_MS) so a
    // hammering consumer gets a fast 503 instead of a radio wake. Cleared on a successful open or a
    // detection. Default 30s (≈ one ffmpeg retry cycle); 0 disables.
    streamFailBackoffMs: env.STREAM_FAIL_BACKOFF_MS != null ? Number(env.STREAM_FAIL_BACKOFF_MS) : 30_000,
    // Event pre-warm: the SDK can speculatively open a camera's P2P session on a high-intent event
    // (doorbell/person/pet/package) so a following live view starts instantly. OFF by default here — it
    // holds a battery camera's radio open for ~28s per event. Set BRIDGE_PREWARM=1 to enable the SDK's
    // default pre-warm events.
    prewarm: truthy(env.BRIDGE_PREWARM),
    // Optional Anker Solix support — a SEPARATE Anker account (its own login + device backend), enabled
    // only when both SOLIX_EMAIL and SOLIX_PASSWORD are set. Independent of the eufy client; its own
    // persisted session file. Country falls back to the eufy country.
    solix:
      env.SOLIX_EMAIL && env.SOLIX_PASSWORD
        ? {
            email: env.SOLIX_EMAIL,
            password: env.SOLIX_PASSWORD,
            country: env.SOLIX_COUNTRY || env.EUFY_COUNTRY || "GB",
            session: env.SOLIX_SESSION || "./data/.solix-session.json",
            // Cadence of the scene backstop poll — the slow authed read that fills the gap fields
            // (battery temperature + a SOC cross-check) the MQTT push doesn't carry. Deliberately slow:
            // Anker throttles frequent reads, and realtime already comes from the push. Default 90s.
            scenePollMs: Number(env.SOLIX_SCENE_POLL_MS) || 90_000,
            // Login self-heal backoff: after a failed login the bridge retries on an escalating delay
            // (doubling from base, capped at max) rather than tight-looping — Anker throttles frequent
            // logins ("too frequent") and can escalate to a captcha. Base 15 min (past the throttle
            // window), cap 1 h. Raise if you still see throttling; there is rarely a reason to lower.
            retryBaseMs: Number(env.SOLIX_RETRY_BASE_MS) || 15 * 60 * 1000,
            retryMaxMs: Number(env.SOLIX_RETRY_MAX_MS) || 60 * 60 * 1000,
          }
        : undefined,
  };
  // Where the FCM push registration (token + seen-ids) is persisted, beside the session file. Without a
  // pushStore the SDK falls back to MemoryFcmStore and re-registers a fresh token on every restart —
  // wasted work, and it's what makes a same-identity collision bite rather than self-correct (issue #30).
  cfg.pushSession = path.join(path.dirname(cfg.session), ".eufy-fcm.json");

  const DEBUG = truthy(env.BRIDGE_DEBUG);
  const DEBUG_P2P = truthy(env.BRIDGE_DEBUG_P2P);
  const dbg = (...a) => {
    if (DEBUG) console.log("[bridge:dbg]", ...a);
  };

  // Event log — a NARROW, always-on-by-default trace of just the realtime-event path: a push/semantic
  // event arriving, how many frontend (WS) clients it was broadcast to, and each "Last event" image
  // fetch. This is NOT the BRIDGE_DEBUG firehose — it fires only on real events, so it's quiet on an idle
  // system and is what a "why isn't Last event updating" report needs. Set BRIDGE_EVENT_LOG=0 to silence.
  const EVENT_LOG = env.BRIDGE_EVENT_LOG == null ? true : truthy(env.BRIDGE_EVENT_LOG);
  const eventLog = (...a) => {
    if (EVENT_LOG) console.log("[bridge:event]", ...a);
  };

  return {
    cfg,
    SCHEMA_VERSION,
    DEBUG,
    DEBUG_P2P,
    dbg,
    EVENT_LOG,
    eventLog,
    eventImageDir: path.dirname(cfg.session), // last-event thumbnails live beside the session file
    FORWARDED_EVENTS,
    DETECTION_EVENTS,
    PUSH_STALL_MS,
    SUSPEND_RELEASE_MS,
    STREAM_FAIL_BACKOFF_MAX_MS,
  };
}
