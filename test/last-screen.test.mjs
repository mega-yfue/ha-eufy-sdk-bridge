// "Last screen" is the last picture someone WATCHED live (last-live-<sn>.jpg), kept apart from "Last event":
// /last-screen serves only it, and /snapshot?mode=screen prefers it over a newer event thumbnail.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";

function setup({ live = true, event = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screen-"));
  const liveFile = path.join(dir, "last-live-CAM1.jpg");
  const eventFile = path.join(dir, "last-event-CAM1.jpg");
  if (live) fs.writeFileSync(liveFile, "SCREEN");
  if (event) fs.writeFileSync(eventFile, "EVENT");
  // the event is NEWER than the last screen - the case "mode=screen" exists for
  if (live && event) {
    const t = Date.now() / 1000;
    fs.utimesSync(liveFile, t - 3600, t - 3600);
    fs.utimesSync(eventFile, t, t);
  }
  let wakes = 0;
  const cam = {
    snapshotLive: async () => {
      wakes += 1;
      return { jpeg: Buffer.from("LIVE") };
    },
    snapshotStored: async () => Buffer.from("STORED"),
  };
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" });
  const state = createState();
  state.flags.ready = true;
  const ctx = {
    ...config,
    state,
    eventImageDir: dir,
    eventLog: () => {},
    authStatus: () => ({ status: "ok" }),
    eufy: {
      async getDevice() {
        return { camera: () => cam, describe: () => ({ sn: "CAM1", capabilities: ["camera", "video", "battery"] }) };
      },
    },
  };
  return { handler: createHttpHandler(ctx), wakes: () => wakes };
}

async function get(handler, url) {
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

test("/last-screen serves the last watched picture with its time, even when an event is newer", async () => {
  const { handler, wakes } = setup();
  const r = await get(handler, "/last-screen/CAM1");
  assert.equal(r.code, 200);
  assert.equal(String(r.body), "SCREEN");
  assert.match(r.headers["x-saved-at"], /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(wakes(), 0);
});

test("/last-screen is 404 for a camera never watched", async () => {
  const { handler } = setup({ live: false });
  const r = await get(handler, "/last-screen/CAM1");
  assert.equal(r.code, 404);
});

test("/snapshot?mode=screen prefers the last screen over a newer event, without waking the camera", async () => {
  const { handler, wakes } = setup();
  const r = await get(handler, "/snapshot/CAM1?mode=screen");
  assert.equal(r.code, 200);
  assert.equal(String(r.body), "SCREEN");
  assert.equal(wakes(), 0);
});

test("/snapshot without a mode still serves the newer picture (the event) - default unchanged", async () => {
  const { handler } = setup();
  const r = await get(handler, "/snapshot/CAM1");
  assert.equal(String(r.body), "EVENT");
});

test("/snapshot?mode=screen falls back to the event picture for a camera never watched", async () => {
  const { handler, wakes } = setup({ live: false });
  const r = await get(handler, "/snapshot/CAM1?mode=screen");
  assert.equal(r.code, 200);
  assert.equal(String(r.body), "EVENT");
  assert.equal(wakes(), 0);
});

test("/snapshot?mode=screen with nothing on disk is 404, not a wake", async () => {
  const { handler, wakes } = setup({ live: false, event: false });
  const r = await get(handler, "/snapshot/CAM1?mode=screen");
  assert.equal(r.code, 404);
  assert.equal(wakes(), 0);
});
