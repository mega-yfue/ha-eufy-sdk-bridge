// ha-eufy-sdk bridge — one process that logs into eufy ONCE and exposes the SDK to a frontend.
//
//   WS    :PORT/ws             control, state, events, AUTH   (the frontend talks to this)
//   HTTP  :PORT/stream/<sn>    live video (Annex-B)           (go2rtc pulls this)
//   HTTP  :PORT/snapshot/<sn>  a JPEG still
//   HTTP  :PORT/healthz        liveness + auth state + which cameras are streaming
//
// This file is just the WIRING. Each concern lives in src/: config, the SDK client, the shared runtime
// state, auth/session, the liveness watchdog, startup warm-ups, boot, the device view, stream idle-off,
// and the HTTP + WS servers. A single `ctx` object carries config + client + state + each module's
// public functions; modules read their cross-module dependencies off `ctx` at call time, so wiring
// order here does not matter as long as `ctx` is whole before login begins.
import http from "node:http";
import fs from "node:fs";
import { loadConfig } from "./src/config.mjs";
import { createState } from "./src/state.mjs";
import { createEufy } from "./src/client.mjs";
import { createFaces } from "./src/faces.mjs";
import { createDeviceView } from "./src/device-view.mjs";
import { createWarmup } from "./src/warmup.mjs";
import { createStreamIdle } from "./src/stream-idle.mjs";
import { createWatchdog } from "./src/watchdog.mjs";
import { createAuth } from "./src/auth.mjs";
import { createBoot } from "./src/boot.mjs";
import { createSolix } from "./src/solix.mjs";
import { createHttpHandler } from "./src/http-routes.mjs";
import { createWsServer } from "./src/ws-server.mjs";
import { closeStreamClients } from "./streams.mjs";

const config = loadConfig();
const { cfg, DEBUG, DEBUG_P2P, EVENT_LOG, eventImageDir } = config;

// last-event thumbnails live in the (mounted) data dir alongside the session file.
fs.mkdirSync(eventImageDir, { recursive: true });
if (DEBUG) console.log(`[bridge] BRIDGE_DEBUG on — verbose logging (p2p-firehose ${DEBUG_P2P ? "on" : "off"})`);
if (EVENT_LOG)
  console.log(
    '[bridge] event log ON — "[bridge:event]" lines trace each push event + "Last event" image fetch (set BRIDGE_EVENT_LOG=0 to silence)',
  );
if (!cfg.email || !cfg.password) {
  console.error("[bridge] EUFY_EMAIL and EUFY_PASSWORD are required");
  process.exit(1);
}

// ── assemble ctx ────────────────────────────────────────────────────────────────────────────────────
const state = createState();
const eufy = createEufy(config);
const ctx = { ...config, eufy, state };

// Each factory reads its cross-module deps off ctx lazily, so this single merge is enough — nothing here
// is called until login/handlers run, by which point ctx is complete.
Object.assign(
  ctx,
  createFaces(ctx),
  createDeviceView(ctx),
  createWarmup(ctx),
  createStreamIdle(ctx),
  createWatchdog(ctx),
  createAuth(ctx),
  createBoot(ctx),
  createSolix(ctx),
);

const httpServer = http.createServer(createHttpHandler(ctx));
Object.assign(ctx, createWsServer(ctx, httpServer)); // adds send / broadcast / handleMessage

// ── SDK event wiring ──────────────────────────────────────────────────────────────────────────────────
eufy.on("error", (e) => {
  console.error(`[bridge] sdk error: ${e?.message ?? e}`);
  // A kicked/invalid cloud token surfaces as SessionExpiredError (the SDK has already cleared the
  // session) on the generic error bus. Match by name rather than `instanceof` so it still fires under a
  // dual-package install where host and SDK hold different class objects. React immediately instead of
  // waiting out the ~30-min poll-stall watchdog.
  if (e?.name === "SessionExpiredError") ctx.maybeRecoverSession();
});
// Push (FCM) liveness — the watchdog's poll heartbeat can't see a dead push channel (events ride push,
// state rides poll), so track push connect/disconnect explicitly.
eufy.on("pushConnect", () => {
  state.flags.pushConnected = true;
  state.flags.pushSince = Date.now();
});
eufy.on("pushDisconnect", () => {
  state.flags.pushConnected = false;
  state.flags.pushSince = Date.now();
});

// eufy answers a wrong country with the same `200/26108 Email address or password incorrect`
// it uses for a genuinely wrong password, which sends people to debug the one thing that isn't
// wrong (#60). The upstream code doesn't separate the two cases, so don't pretend to — just
// name the other candidate, since it is the one nobody thinks of.
const COUNTRY_HINT =
  " (if the credentials are definitely right, check EUFY_COUNTRY: it must be the country the" +
  " account was registered in)";

function loginFailureHint(e) {
  const msg = String(e?.message ?? e);
  return /26108|password incorrect/i.test(msg) ? msg + COUNTRY_HINT : msg;
}

// ── boot ───────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  // Serve FIRST — the WS must be reachable so a client can drive 2FA/captcha before we're authed.
  httpServer.listen(cfg.port, cfg.host, () => console.log(`[bridge] listening on ${cfg.host}:${cfg.port}`));
  try {
    await ctx.applyLogin(await eufy.login());
  } catch (e) {
    console.error(`[bridge] login attempt failed: ${loginFailureHint(e)} — retry via WS 'auth.retrigger'`);
  }
  if (state.flags.ready) console.log("[bridge] logged in from a stored session");
  else
    console.log(`[bridge] auth required: ${ctx.authStatus().state} — drive it over WS /ws (auth.status / auth.submit)`);

  // Anker Solix is a separate account on a separate backend, so start it independently of the eufy
  // login above — its outcome never gates eufy devices. No-op unless SOLIX_* is configured.
  if (cfg.solix) void ctx.startSolix?.();
}

async function shutdown() {
  const { timers, flags } = state;
  if (timers.watchdog) clearInterval(timers.watchdog);
  if (timers.streamIdle) clearInterval(timers.streamIdle);
  if (timers.rtspIdle) clearInterval(timers.rtspIdle);
  flags.go2rtcProc?.kill();
  await closeStreamClients();
  await ctx.stopSolix?.();
  await eufy.disconnect?.();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  console.error("[bridge] fatal:", e);
  process.exit(1);
});
