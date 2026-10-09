// /snapshot must never answer "no image" while a persisted last-event thumbnail sits on disk: a caller
// that gets nothing falls back to pulling video, which wakes a battery-capable camera for a picture we already
// have. Drives the real handler against a fake SDK camera whose live/stored paths fail the way an
// account without push thumbnails fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]); // enough to be recognisable

/** A handler over a fake camera; `live` / `stored` decide how those two paths behave. */
function setup({ live, stored, env = {}, persist = true, battery = true, ready = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
  if (persist) fs.writeFileSync(path.join(dir, "last-event-CAM1.jpg"), JPEG);
  const calls = { live: 0, stored: 0 };
  const cam = {
    snapshotLive: async () => {
      calls.live += 1;
      if (live === "throw") throw new Error("P2P unreachable");
      if (live === "empty") return { jpeg: undefined };
      return { jpeg: Buffer.from("LIVE") };
    },
    snapshotStored: async () => {
      calls.stored += 1;
      if (stored === "throw") {
        const e = new Error("No stored snapshot is available");
        e.reason = "not-observed";
        throw e;
      }
      if (stored === "empty") return undefined;
      return Buffer.from("STORED");
    },
  };
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", ...env });
  const state = createState();
  state.flags.ready = ready;
  const ctx = {
    ...config,
    state,
    eventImageDir: dir,
    eventLog: () => {},
    authStatus: () => ({ status: ready ? "ok" : "pending" }),
    eufy: {
      async getDevice() {
        return {
          camera: () => cam,
          // A battery-capable camera pays a radio wake per still; one without that capability does not. The route reads this.
          describe: () => ({
            sn: "CAM1",
            capabilities: battery ? ["camera", "video", "battery"] : ["camera", "video"],
          }),
        };
      },
    },
  };
  return { handler: createHttpHandler(ctx), calls, dir };
}

/** Run one GET and capture status + body. */
async function get(handler, url = "/snapshot/CAM1") {
  const out = {};
  const res = {
    writeHead(code, headers) {
      out.code = code;
      out.headers = headers;
    },
    end(body) {
      out.body = body;
    },
  };
  await handler({ url, headers: { host: "localhost" }, on() {} }, res);
  return out;
}

// Tests that exercise the live path pin `battery: false`: the default "auto" only bursts a mains camera.
test("snapshot: serves the persisted thumbnail when live and stored both fail", async () => {
  const { handler, calls } = setup({ live: "throw", stored: "throw", battery: false });
  const out = await get(handler);
  assert.equal(out.code, 200); // was a 502 before: the caller then pulled video to get a picture
  assert.equal(out.headers["content-type"], "image/jpeg");
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 1); // a mains camera still gets the burst by default
});

test("snapshot: SNAPSHOT_LIVE=0 never wakes the camera", async () => {
  const { handler, calls } = setup({ live: "throw", stored: "throw", env: { SNAPSHOT_LIVE: "0" } });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 0); // no live burst at all — the whole point of the switch
});

test("snapshot: a live still still wins when the camera delivers one", async () => {
  const { handler, calls } = setup({ battery: false });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVE");
  assert.equal(calls.stored, 0); // no need to fall back
});

test("snapshot: reports why when there is no image anywhere", async () => {
  const { handler } = setup({ live: "throw", stored: "throw", persist: false, battery: false });
  const out = await get(handler);
  assert.equal(out.code, 404);
  const body = JSON.parse(out.body);
  assert.match(body.reason, /live burst failed/);
  assert.match(body.reason, /nothing retained/);
});

test("snapshot: bare live request keeps defined diagnostics when acquisition has no image", async () => {
  for (const storedMode of ["empty", "throw"]) {
    const { handler, calls } = setup({
      live: "empty",
      stored: storedMode,
      persist: false,
      battery: true,
      env: { SNAPSHOT_LIVE: "1" },
    });
    const out = await get(handler);
    const body = JSON.parse(out.body);
    assert.equal(out.code, 404);
    assert.equal(typeof body.reason, "string");
    assert.doesNotMatch(body.reason, /undefined/);
    assert.doesNotMatch(body.reason, /mode=(live|auto)/);
    if (storedMode === "throw") assert.match(body.reason, /nothing retained: not-observed/);
    assert.deepEqual(calls, { live: 1, stored: 1 });
  }
});

test("snapshot: SNAPSHOT_LIVE=0 answers from disk without consulting the retained thumbnail", async () => {
  const { handler, calls } = setup({ stored: "throw", env: { SNAPSHOT_LIVE: "0" } });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 0);
  assert.equal(calls.stored, 0); // the disk copy is served first — no pointless round-trip per fetch
});

test("snapshot: no mode with SNAPSHOT_LIVE=auto spares a battery-capable camera the live burst", async () => {
  const { handler, calls } = setup({ live: "throw", stored: "throw", env: { SNAPSHOT_LIVE: "auto" }, battery: true });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG); // served from disk
  assert.equal(calls.live, 0); // never wake a camera that runs on a battery
});

test("snapshot: default (auto) still takes a live still from a mains camera", async () => {
  const { handler, calls } = setup({ battery: false });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVE"); // free for a mains device, so take the current picture
  assert.equal(calls.live, 1);
});

test("snapshot: SNAPSHOT_LIVE=1 forces the burst even on a battery-capable camera", async () => {
  const { handler, calls } = setup({ battery: true, env: { SNAPSHOT_LIVE: "1" } });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVE");
  assert.equal(calls.live, 1);
});

test("snapshot: mode=auto keeps the automatic battery-capability policy", async () => {
  const { handler, calls } = setup({ battery: true, env: { SNAPSHOT_LIVE: "1" } });
  const out = await get(handler, "/snapshot/CAM1?mode=auto");
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 0);
});

test("snapshot: mode=auto diagnostics describe the explicit policy, not the global setting", async () => {
  const { handler } = setup({
    live: "empty",
    stored: "empty",
    persist: false,
    battery: true,
    env: { SNAPSHOT_LIVE: "1" },
  });
  const out = await get(handler, "/snapshot/CAM1?mode=auto");
  assert.equal(out.code, 404);
  assert.match(JSON.parse(out.body).reason, /explicit mode=auto/);
  assert.doesNotMatch(JSON.parse(out.body).reason, /SNAPSHOT_LIVE/);
});

test("snapshot: mode=auto reports an empty live result without referring to global settings", async () => {
  const { handler } = setup({
    live: "empty",
    stored: "empty",
    persist: false,
    battery: false,
    env: { SNAPSHOT_LIVE: "0" },
  });
  const out = await get(handler, "/snapshot/CAM1?mode=auto");
  assert.equal(out.code, 404);
  assert.equal(JSON.parse(out.body).reason, "mode=auto live burst produced no usable image");
});

test("snapshot: mode=auto takes a live still from a camera without battery capability despite SNAPSHOT_LIVE=0", async () => {
  const { handler, calls } = setup({ battery: false, env: { SNAPSHOT_LIVE: "0" } });
  const out = await get(handler, "/snapshot/CAM1?mode=auto");
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVE");
  assert.equal(calls.live, 1);
  assert.equal(calls.stored, 0);
});

test("snapshot: mode=stored never invokes live snapshot acquisition", async () => {
  const { handler, calls } = setup({ battery: true, env: { SNAPSHOT_LIVE: "1" } });
  const out = await get(handler, "/snapshot/CAM1?mode=stored");
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 0);
});

test("snapshot: mode=stored uses snapshotStored when no image is persisted", async () => {
  const { handler, calls } = setup({ persist: false });
  const out = await get(handler, "/snapshot/CAM1?mode=stored");
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "STORED");
  assert.equal(calls.stored, 1);
  assert.equal(calls.live, 0);
});

test("snapshot: mode=stored returns 404 when stored and persisted images are unavailable", async () => {
  for (const storedMode of ["throw", "empty"]) {
    const { handler, calls } = setup({ persist: false, stored: storedMode });
    const out = await get(handler, "/snapshot/CAM1?mode=stored");
    assert.equal(out.code, 404);
    assert.equal(JSON.parse(out.body).error, "no image available");
    assert.equal(calls.stored, 1);
    assert.equal(calls.live, 0);
  }
});

test("snapshot: mode=live attempts live snapshot acquisition for a battery-capable camera", async () => {
  const { handler, calls } = setup({ battery: true, env: { SNAPSHOT_LIVE: "0" } });
  const out = await get(handler, "/snapshot/CAM1?mode=live");
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVE");
  assert.equal(calls.live, 1);
});

test("snapshot: mode=live falls back to stored and persisted images after live failure", async () => {
  for (const liveMode of ["throw", "empty"]) {
    const fromStored = setup({ live: liveMode, persist: false });
    const storedOut = await get(fromStored.handler, "/snapshot/CAM1?mode=live");
    assert.equal(storedOut.code, 200);
    assert.equal(storedOut.body.toString(), "STORED");
    assert.equal(fromStored.calls.live, 1);
    assert.equal(fromStored.calls.stored, 1);
  }

  const fromPersisted = setup({ live: "throw", stored: "throw" });
  const persistedOut = await get(fromPersisted.handler, "/snapshot/CAM1?mode=live");
  assert.equal(persistedOut.code, 200);
  assert.deepEqual(persistedOut.body, JPEG);
  assert.equal(fromPersisted.calls.live, 1);
  assert.equal(fromPersisted.calls.stored, 1);
});

test("snapshot: mode=live reports a reason when all acquisition paths return no image", async () => {
  const { handler, calls } = setup({ live: "empty", stored: "empty", persist: false });
  const out = await get(handler, "/snapshot/CAM1?mode=live");
  assert.equal(out.code, 404);
  assert.equal(JSON.parse(out.body).reason, "live burst produced no usable image");
  assert.deepEqual(calls, { live: 1, stored: 1 });
});

test("snapshot: invalid mode is rejected", async () => {
  const { handler } = setup();
  const out = await get(handler, "/snapshot/CAM1?mode=burst");
  assert.equal(out.code, 400);
  assert.deepEqual(JSON.parse(out.body), { error: "invalid snapshot mode", mode: "burst" });
});

test("snapshot: empty mode is rejected", async () => {
  const { handler, calls } = setup();
  const out = await get(handler, "/snapshot/CAM1?mode=");
  assert.equal(out.code, 400);
  assert.deepEqual(JSON.parse(out.body), { error: "invalid snapshot mode", mode: "" });
  assert.deepEqual(calls, { live: 0, stored: 0 });
});

test("snapshot: duplicate mode parameters are rejected regardless of value or order", async () => {
  for (const query of ["mode=stored&mode=live", "mode=live&mode=stored", "mode=stored&mode=stored"]) {
    const { handler, calls } = setup();
    const out = await get(handler, `/snapshot/CAM1?${query}`);
    assert.equal(out.code, 400);
    assert.deepEqual(JSON.parse(out.body), {
      error: "snapshot mode must be specified at most once",
    });
    assert.deepEqual(calls, { live: 0, stored: 0 });
  }
});

test("snapshot: mode validation follows readiness and applies only to the snapshot route", async () => {
  const unready = setup({ ready: false });
  const unreadyOut = await get(unready.handler, "/snapshot/CAM1?mode=invalid");
  assert.equal(unreadyOut.code, 503);
  assert.deepEqual(JSON.parse(unreadyOut.body), {
    error: "not authenticated",
    auth: { status: "pending" },
  });

  const { handler, calls } = setup({ persist: false });
  const missingDevicePath = await get(handler, "/snapshot?mode=invalid");
  assert.equal(missingDevicePath.code, 404);
  assert.deepEqual(JSON.parse(missingDevicePath.body), { error: "not found" });
  assert.deepEqual(calls, { live: 0, stored: 0 });

  const otherRoute = await get(handler, "/event-image/CAM1?mode=invalid");
  assert.equal(otherRoute.code, 200);
  assert.equal(calls.stored, 1);
});

test("snapshot: sequential modes remain request-local", async () => {
  const { handler, calls } = setup({ persist: false });

  const stored = await get(handler, "/snapshot/CAM1?mode=stored");
  assert.equal(stored.body.toString(), "STORED");
  assert.deepEqual(calls, { live: 0, stored: 1 });

  const live = await get(handler, "/snapshot/CAM1?mode=live");
  assert.equal(live.body.toString(), "LIVE");
  assert.deepEqual(calls, { live: 1, stored: 1 });
});

test("snapshot: serves the last live picture when it is newer than the last event", async () => {
  const { handler, calls, dir } = setup({ live: "throw", stored: "throw", battery: true });
  const live = path.join(dir, "last-live-CAM1.jpg");
  fs.writeFileSync(live, Buffer.from("LIVEFRAME"));
  const past = new Date(Date.now() - 3_600_000); // the event was an hour ago
  fs.utimesSync(path.join(dir, "last-event-CAM1.jpg"), past, past);
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVEFRAME");
  assert.equal(calls.live, 0); // still never woke the battery-capable camera
});

test("snapshot: a newer event thumbnail wins over an older live picture", async () => {
  const { handler, dir } = setup({ live: "throw", stored: "throw", battery: true });
  const live = path.join(dir, "last-live-CAM1.jpg");
  fs.writeFileSync(live, Buffer.from("LIVEFRAME"));
  const past = new Date(Date.now() - 3_600_000); // someone watched an hour ago, the event is fresh
  fs.utimesSync(live, past, past);
  const out = await get(handler);
  assert.deepEqual(out.body, JPEG);
});
