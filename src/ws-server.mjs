// The WebSocket control plane: state, events, and auth over one socket. Attaches to the shared HTTP
// server so a client can reach /ws to drive 2FA/captcha before the bridge is authenticated. Owns the
// client set and the two fan-out helpers (`send`, `broadcast`) that the rest of the bridge publishes
// through — returned so server.mjs can hang them on ctx for auth.mjs / boot.mjs / http-routes.mjs.
import { WebSocketServer } from "ws";
import { listLightEffects } from "@mega-yfue/eufy-sdk";
import { SOLIX_CONTROLS, SOLIX_DISABLED } from "./solix.mjs";

// Commands that require an authenticated eufy session — gated in one place before dispatch. (auth.* and
// solix.* run before this gate, so a client can drive 2FA/captcha and Solix while eufy is still pending.)
const AUTHED_COMMANDS = new Set([
  "devices.list",
  "device.state",
  "device.properties",
  "device.set",
  "device.action",
  "device.reboot",
  "event.refresh",
  "light.effects",
  "config.get",
  "config.set",
  "stream.start",
  "stream.stop",
]);

export function createWsServer(ctx, httpServer) {
  const { cfg, eufy, SCHEMA_VERSION, DEBUG, dbg } = ctx;
  const { flags, clients } = ctx.state;

  const send = (ws, obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const broadcast = (obj) => {
    const s = JSON.stringify(obj);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s);
  };

  // The smart-light effect gallery is account-wide and costs several HTTP round-trips to enumerate,
  // so fetch it once and cache it (a client can force a refresh with `{ refresh: true }`).
  let effectsCache = null;

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    // On connect, tell the client the schema AND the current auth state, so a frontend knows immediately
    // whether it must drive a 2FA/captcha step before anything else works.
    send(ws, { event: "hello", schemaVersion: SCHEMA_VERSION, auth: ctx.authStatus() });
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (raw) => handleMessage(ws, raw).catch((e) => console.error("[bridge] ws:", e)));
  });

  async function handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { ok: false, error: "bad json" });
    }
    const { id, cmd } = msg;
    if (DEBUG) {
      const bits = [`cmd=${cmd}`];
      if (msg.sn != null) bits.push(`sn=${msg.sn}`);
      if (msg.name != null) bits.push(`name=${msg.name}`);
      if (msg.value !== undefined) bits.push(`value=${JSON.stringify(msg.value)}`);
      dbg("ws recv", bits.join(" ")); // NB: 2FA code / captcha (msg.code/msg.captcha) never logged
    }
    const reply = (extra) => send(ws, { id, ok: true, ...extra });
    const fail = (error) => send(ws, { id, ok: false, error: String(error?.message ?? error) });
    // Reject a bad request by throwing — the outer catch renders it as { ok:false, error }, the same
    // client-visible result as `return fail(...)`, so the shared guards below don't thread a return.
    const reject = (message) => {
      throw new Error(message);
    };
    try {
      // Anker Solix control commands (table above) all share the same enable + target-device guards, so
      // dispatch them here instead of repeating those two lines in ~10 near-identical switch cases.
      const control = SOLIX_CONTROLS[cmd];
      if (control) {
        const fn = ctx[control.fn] ?? reject(SOLIX_DISABLED);
        if (!msg.deviceSn) reject(`${cmd} needs ${control.needs}`);
        for (const field of control.req ?? []) if (msg[field] == null) reject(`${cmd} needs ${control.needs}`);
        if (control.check && !control.check(msg)) reject(`${cmd} needs ${control.needs}`);
        return reply(control.out(msg, await control.run(fn, msg)));
      }

      // Everything else that isn't auth/Solix-status needs an authenticated eufy session.
      if (AUTHED_COMMANDS.has(cmd) && !flags.ready) {
        return fail("not authenticated — query auth.status and complete 2FA/captcha first");
      }

      switch (cmd) {
        // ── auth ──
        case "auth.status":
          return reply({ auth: ctx.authStatus() });
        case "auth.submit": {
          // A 2FA code (`code`) or a captcha answer (`captcha`). The pending id/token is held in the SDK.
          if (msg.captcha != null) await ctx.applyLogin(await eufy.solveCaptcha(String(msg.captcha)));
          else if (msg.code != null) await ctx.applyLogin(await eufy.submitVerifyCode(String(msg.code)));
          else return fail("auth.submit needs { code } (2FA) or { captcha } (captcha answer)");
          return reply({ auth: ctx.authStatus() });
        }
        case "auth.retrigger":
          // Re-request a fresh challenge (new captcha image / new 2FA code).
          await ctx.applyLogin(await eufy.login());
          return reply({ auth: ctx.authStatus() });

        // ── Anker Solix status / challenge (not device controls — no target device / graceful when off) ──
        case "solix.status":
          return reply({ solix: ctx.solixStatus?.() ?? { enabled: false, state: "disabled", deviceCount: 0 } });
        case "solix.devices":
          return reply({ devices: ctx.solixDeviceList?.() ?? [] });
        case "solix.submitCode": {
          if (!ctx.solixSubmitCode) return fail(SOLIX_DISABLED);
          await ctx.solixSubmitCode(msg.code); // NB: the 2FA code (msg.code) is never logged
          return reply({ solix: ctx.solixStatus() });
        }

        // ── device control (require auth — gated above) ──
        case "devices.list":
          return reply({ devices: await ctx.deviceList() });
        case "device.state":
          return reply({ device: await ctx.describeDevice(msg.sn) });
        case "device.properties": {
          const dev = await eufy.getDevice(msg.sn);
          return reply({ sn: msg.sn, properties: ctx.propertySpecs(dev) });
        }
        case "device.set": {
          const t0 = Date.now();
          dbg(`device.set → setProperty sn=${msg.sn} name=${msg.name} value=${JSON.stringify(msg.value)}`);
          try {
            await eufy.setProperty(msg.sn, msg.name, msg.value);
            dbg(`device.set OK sn=${msg.sn} name=${msg.name} (${Date.now() - t0}ms)`);
          } catch (e) {
            console.error(
              `[bridge] device.set FAILED sn=${msg.sn} name=${msg.name} (${Date.now() - t0}ms): ${e?.name ?? "Error"}: ${e?.message ?? e}`,
            );
            throw e; // outer catch surfaces it to the frontend (+ triggers session recovery if kicked)
          }
          return reply({});
        }
        case "device.action": {
          // Invoke a capability ACTION — a typed method that isn't a scalar writable property, so
          // `device.set` can't reach it (e.g. smart_light setColor({red,green,blue}) / setEffect(id)).
          // `{ sn, action, args? }`; args is the positional argument list. Only capability-surface
          // methods are reachable — the same controls the SDK intends a caller to invoke.
          const action = String(msg.action ?? "");
          const args = Array.isArray(msg.args) ? msg.args : [];
          const dev = await eufy.getDevice(msg.sn);
          // Capability surfaces that expose actions. Add more accessors here as needed.
          const surfaces = [dev.smartLight?.(), dev.camera?.(), dev.lock?.(), dev.siren?.(), dev.ptz?.()].filter(
            Boolean,
          );
          // A dotted action walks a sub-API namespace: `preset.goto` is `ptz().preset().goto(id)`.
          // Every segment before the leaf ANSWERS — it hands back the namespace without acting — so it
          // takes no arguments; only the leaf is called with `args`.
          const path = action.split(".");
          const leaf = path.pop();
          let target = surfaces.find((s) => typeof s?.[path[0] ?? leaf] === "function");
          for (const seg of path) target = typeof target?.[seg] === "function" ? target[seg]() : undefined;
          if (typeof target?.[leaf] !== "function") return fail(`no action '${action}' on ${msg.sn}`);
          const t0 = Date.now();
          dbg(`device.action → ${action} sn=${msg.sn} args=${JSON.stringify(args)}`);
          try {
            const result = await target[leaf](...args);
            dbg(`device.action OK ${action} sn=${msg.sn} (${Date.now() - t0}ms)`);
            return reply({ result: result ?? null });
          } catch (e) {
            console.error(
              `[bridge] device.action FAILED ${action} sn=${msg.sn} (${Date.now() - t0}ms): ${e?.name ?? "Error"}: ${e?.message ?? e}`,
            );
            throw e;
          }
        }
        case "device.reboot": {
          // HomeBase-only; SDK throws for a non-hub serial. The hub drops offline for a minute or two.
          await eufy.reboot(msg.sn);
          return reply({});
        }
        case "event.refresh": {
          // Manual "Last event" image refresh (debug/force button): pull the newest cover NOW and nudge
          // HA. Answers { changed } — true when a genuinely newer image landed.
          const changed = ctx.forceRefreshEventImage ? await ctx.forceRefreshEventImage(msg.sn) : false;
          return reply({ changed });
        }
        case "light.effects": {
          // The smart-light effect gallery (id + display name) for HA's effect_list. Cached; pass
          // { refresh:true } to rebuild. Only the entries the SDK can actually drive over the wire.
          if (!effectsCache || msg.refresh) {
            // The SDK exposes the gallery as a barrel export over the public `eufy.api` (MegaHttpClient)
            // — no facade forwarder needed. Widen the scan past the default 10001-10999: devices also
            // carry effects in the 20000 band (e.g. 20006 on a T8L02), and batchget returns only ids
            // that exist, so a wider window just enumerates more. NB: this is ~110 sequential batchget
            // round-trips + discover/list on a cold cache — hence the module-level cache above.
            const all = await listLightEffects(eufy.api, { idRange: [10001, 20999] });
            effectsCache = all
              .filter((e) => e.buildable)
              .map((e) => ({ id: e.lightId, name: e.name || `Effect ${e.lightId}`, colors: e.colors }));
            dbg(`light.effects → ${effectsCache.length} buildable effect(s)`);
          }
          return reply({ effects: effectsCache });
        }
        case "config.get":
          // Current effective cloud poll interval (ms). 0 means polling is disabled.
          return reply({ pollMs: eufy.pollIntervalMs });
        case "config.set": {
          // Change the cloud poll interval live. Expect a non-negative integer (ms); 0 disables.
          const ms = Number(msg.pollMs);
          if (!Number.isFinite(ms) || ms < 0) return fail("pollMs must be a non-negative number (ms)");
          eufy.setPollInterval(ms);
          return reply({ pollMs: eufy.pollIntervalMs });
        }
        case "stream.start":
          // Returns URLs; does NOT open the camera — the media connection does that.
          return reply({
            path: `/stream/${msg.sn}`,
            http: `http://${cfg.selfHost}:${cfg.port}/stream/${msg.sn}`,
            rtsp: `rtsp://${cfg.selfHost}:8554/${msg.sn}`,
          });
        case "stream.stop":
          return reply({}); // advisory; the media connection is the real signal

        default:
          return fail(`unknown cmd: ${cmd}`);
      }
    } catch (e) {
      if (e?.name === "SessionExpiredError") ctx.maybeRecoverSession();
      return fail(e);
    }
  }

  return { send, broadcast, handleMessage };
}
