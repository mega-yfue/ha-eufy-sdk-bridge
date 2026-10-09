// The bridge's shared, mutable runtime state — one place instead of a dozen module-level `let`s. Every
// module reads/writes through the object returned here (passed on `ctx`), so a flag set in auth.mjs is
// visible to the watchdog and the WS handler without exporting reassignable bindings across modules.
//
// `createState()` (rather than a bare singleton) lets a test build a fresh, isolated state per case.

/** Build a fresh runtime-state container: the mutable flags plus the live collections. */
export function createState() {
  return {
    // Mutable scalar flags — grouped so cross-module writes stay legible.
    flags: {
      ready: false, // logged in + booted
      sessionLost: false, // cloud token kicked/expired AFTER boot → re-auth needed (ready stays true so
      // completeBoot's one-time wiring is not re-run; authStatus reflects the loss)
      lastLogin: undefined, // the most recent LoginResult (undefined until the first attempt)
      booting: false,
      recovering: false, // a re-auth / push recovery is in flight — blocks the watchdog racing it
      pushConnected: false,
      pushSince: Date.now(),
      go2rtcProc: undefined,
    },
    // Interval handles, armed once at boot and cleared on shutdown.
    timers: { watchdog: null, streamIdle: null, rtspIdle: null },

    clients: new Set(), // connected WS clients (broadcast targets)
    streaming: new Set(), // sns with a live P2P feed piping right now

    // person_id -> { name, familiar } — the HomeBase edge-AI face roster, built once at startup.
    faceNames: new Map(),

    // sn -> { jpeg, at } — the retained push thumbnail and when it first appeared (stored-thumbnail.mjs).
    storedThumbSeen: new Map(),

    // ── live-stream idle auto-off bookkeeping ──
    lastDetect: new Map(), // sn -> ms of the most recent detection
    activeStreams: new Map(), // sn -> { feed, startedAt, lease?, peers? } for feeds currently piping
    idleSuspended: new Set(), // sns torn down for idleness; reopen blocked until motion or consumer-gone
    lastPullAttempt: new Map(), // sn -> ms go2rtc last asked for /stream (even while suspended)
    rtspLastActive: new Map(), // sn -> ms of last detection/stream, for the battery rtspStream auto-off
    streamBackoff: new Map(), // sn -> { until, streak } — fast-503 after a failed open so a hammering consumer can't wake the radio every retry

    // ── optional Anker Solix (separate account/backend; only populated when SOLIX_* is configured) ──
    solix: {
      status: "disabled", // disabled | connecting | 2fa | ready | error
      devices: new Map(), // sn -> SolixDevice
      client: undefined, // SolixClient
      mqtt: undefined, // SolixMqtt telemetry stream
    },
  };
}
