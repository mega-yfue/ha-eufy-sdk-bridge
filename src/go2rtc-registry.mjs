// Discovery can be incomplete at boot. Register missing metadata without opening a camera feed or
// replacing a source viewers already use. go2rtc's PUT/DELETE API persists each successful change.
import {
  cameraStreams,
  configuredStreams,
  forgetConfiguredDevice,
  isDeviceStream,
  rememberConfiguredStreams,
} from "../go2rtc-config.mjs";

export function createGo2rtcRegistry(ctx, request = fetch) {
  const { cfg } = ctx;
  const removed = new Set();
  let tail = Promise.resolve();
  let sweep;

  function enqueue(operation) {
    const result = tail.then(operation);
    tail = result.catch(() => {}); // one failed request must not prevent a later retry
    return result;
  }

  function running() {
    const { flags } = ctx.state;
    return cfg.go2rtcEnable !== false && flags.go2rtcProc && !flags.recovering && !flags.sessionLost;
  }

  const forgotten = (name) => [...removed].some((sn) => isDeviceStream(name, sn));

  async function api(method, params = []) {
    const url = new URL(`http://127.0.0.1:${cfg.go2rtcApiPort ?? 1984}/api/streams`);
    url.search = new URLSearchParams(params).toString();
    const response = await request(url.href, { method, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`go2rtc registry ${method}: HTTP ${response.status}`);
    return response;
  }

  async function reconcile() {
    if (!running()) return;
    const devices = await ctx.deviceList();
    const desired = await configuredStreams(cfg);
    for (const [name, sources] of cameraStreams(cfg, devices)) desired.set(name, sources);
    if (!desired.size && !removed.size) return;

    const live = await (await api("GET")).json();
    if (!live || typeof live !== "object" || Array.isArray(live)) throw new Error("Invalid go2rtc streams response");
    for (const name of Object.keys(live)) {
      if (forgotten(name)) {
        await api("DELETE", [["src", name]]);
        delete live[name];
      }
    }
    for (const [name, value] of desired) {
      if (forgotten(name) || Object.hasOwn(live, name)) continue;
      const sources = typeof value === "string" ? [value] : value;
      // Preserve unrelated go2rtc configuration objects on disk; these are not the bridge's source list.
      if (!Array.isArray(sources) || !sources.length || !sources.every((source) => typeof source === "string"))
        continue;
      await api("PUT", [["name", name], ...sources.map((source) => ["src", source])]);
      live[name] = {};
      ctx.dbg?.(`go2rtc registered missing source ${name}`);
    }
    await rememberConfiguredStreams(
      cfg,
      [...desired].filter(([name]) => !forgotten(name) && Object.hasOwn(live, name)),
    );
  }

  function syncGo2rtcRegistry() {
    if (!sweep) sweep = enqueue(reconcile).finally(() => (sweep = undefined));
    return sweep;
  }

  function forgetGo2rtcDevice(sn) {
    if (typeof sn !== "string" || !sn) return Promise.resolve();
    // Set immediately: a sweep already awaiting discovery must not re-add this device.
    removed.add(sn);
    return enqueue(async () => {
      if (!removed.has(sn)) return; // a later deviceAdded event superseded this queued removal
      await forgetConfiguredDevice(cfg, sn);
      await reconcile();
    });
  }

  function rememberGo2rtcDevice(sn) {
    if (typeof sn !== "string" || !sn) return Promise.resolve();
    removed.delete(sn);
    return syncGo2rtcRegistry();
  }

  return { syncGo2rtcRegistry, forgetGo2rtcDevice, rememberGo2rtcDevice };
}
