// Construct the one EufyMega SDK client the bridge logs in with. Kept tiny and dependency-light so the
// heavier modules depend on the instance via `ctx.eufy`, not on how it was built. Event wiring that
// needs other modules (error → session recovery, push liveness) lives in server.mjs, after ctx is whole.
import { EufyMega, FileSessionStore, FileFcmStore, ConsoleLogger } from "@mega-yfue/eufy-sdk";

/**
 * Build the SDK client from config. `logger` is attached only under BRIDGE_DEBUG_P2P (raw transport logs).
 *
 * The logger is constructed WITHOUT a level so `ConsoleLogger`'s own `"debug"` default applies. The
 * transport lines this flag exists for are emitted at `debug`, and `LEVEL_RANK` puts `debug` below
 * `info`, so passing `"info"` here silenced exactly what the flag is meant to turn on: with it set you
 * got `p2pConnect` and nothing else, never the `[p2p] <sn> <<< …` frames.
 */
export function createEufy({ cfg, DEBUG_P2P }) {
  const eufy = new EufyMega({
    email: cfg.email,
    password: cfg.password,
    countryCode: cfg.country,
    store: new FileSessionStore(cfg.session),
    // Persist the FCM push registration so a restart RECONNECTS with the same token + seen-ids instead of
    // re-registering fresh each boot (the SDK defaults to MemoryFcmStore without this). See issue #30.
    pushStore: new FileFcmStore(cfg.pushSession),
    // Distinct per-install identity when set (BRIDGE_OPENUDID); undefined → the SDK's email-derived
    // default. Set it when running more than one client on an account (see cfg.openudid).
    openudid: cfg.openudid,
    pollMs: cfg.pollMs, // undefined → SDK default; changeable live via config.set
    // Event pre-warm is OFF by default (`[]` = no event opens P2P speculatively) so a battery camera's
    // radio isn't held open ~28s per doorbell/person/pet/package event. BRIDGE_PREWARM=1 → undefined,
    // which lets the SDK use its default high-intent pre-warm events.
    prewarmEvents: cfg.prewarm ? undefined : [],
    logger: DEBUG_P2P ? new ConsoleLogger() : undefined,
  });
  memoizeGetDevice(eufy);
  return eufy;
}

/**
 * One live Device per serial, shared by every caller.
 *
 * The SDK's `getDevice(sn)` rebuilds the whole device model on EVERY call — it awaits the first
 * realtime state, re-reads the registry, rebuilds the command context and re-binds every capability
 * — about 1–2 s per device. `devices.list` described 32 devices that way on every host poll (~6.5 s),
 * and under any extra load (a burst of arming pushes each triggering a refresh) it overran the host's
 * 15 s poll timeout, marking every entity unavailable for a full poll interval.
 *
 * Caching is safe because the SDK delivers realtime updates to the *latest* Device it handed out for
 * a serial (`liveDevices` holds a WeakRef to it); with every caller sharing this one object it stays
 * the live target and keeps receiving pushes and background refreshes. The cache is dropped on every
 * successful (re-)login (`eufy.forgetDevices()`), since a fresh session rebinds command sinks. That is
 * also the only point where a device that MOVED to another HomeBase gets a fresh command context: until
 * then its cached Device keeps the old station and channel (rare, so not handled beyond re-login).
 *
 * A serial that leaves the account (removed or unshared) is pruned on the next `getDevices()`, so
 * `device.*` commands for it fail with "no device" instead of answering from a stale model, and the
 * SDK's WeakRef in `liveDevices` can clear. `getDevices()` keeps previously known devices on a partial
 * cloud outage, so a transient failure evicts nothing that still exists.
 */
export function memoizeGetDevice(eufy) {
  const cache = new Map(); // sn -> Promise<Device>
  const real = eufy.getDevice.bind(eufy);
  eufy.getDevice = (sn) => {
    let p = cache.get(sn);
    if (!p) {
      p = real(sn).catch((e) => {
        cache.delete(sn); // don't pin a failed resolution
        throw e;
      });
      cache.set(sn, p);
    }
    return p;
  };
  const realList = eufy.getDevices.bind(eufy);
  eufy.getDevices = async () => {
    const devices = await realList();
    const live = new Set(devices.map((d) => d.sn));
    for (const sn of cache.keys()) if (!live.has(sn)) cache.delete(sn);
    return devices;
  };
  eufy.forgetDevices = () => cache.clear();
}
