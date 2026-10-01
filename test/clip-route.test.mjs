// /clip/<sn> serves the recording a HomeBase 2 stored for a camera's latest detection. Drives the real
// handler and clip module against a fake SDK camera and a fake muxer, so neither a station nor ffmpeg is
// needed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createClips } from "../src/clip.mjs";

const PUSH = { deviceSn: "CAM1", cipher: 241, payload: { p: "20260101120000" } };

/** A handler over one camera; `download` stands in for the SDK's `downloadRecording`. */
function setup({ download = async () => ({ video: Buffer.from("V"), frames: 10 }), settleMs = "0" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-"));
  const calls = { download: [], mux: 0 };
  const cam = {};
  if (download)
    cam.downloadRecording = async (opts) => {
      calls.download.push(opts);
      return download(opts);
    };
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", CLIP_SETTLE_MS: settleMs });
  const state = createState();
  state.flags.ready = true;
  const ctx = {
    ...config,
    state,
    eventImageDir: dir,
    eventLog: () => {},
    authStatus: () => ({ status: "ok" }),
    eufy: { getDevice: async () => ({ camera: () => cam }) },
    muxClip: async (clip, out) => {
      calls.mux += 1;
      await fs.promises.writeFile(out, Buffer.concat([Buffer.from("MP4:"), clip.video]));
    },
  };
  Object.assign(ctx, createClips(ctx));
  return { handler: createHttpHandler(ctx), ctx, calls, dir };
}

async function get(handler, url = "/clip/CAM1") {
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

test("clip: 404 on a camera whose SDK offers no stored recordings", async () => {
  const { handler, ctx } = setup({ download: null });
  ctx.noteRecording(PUSH);
  const out = await get(handler);
  assert.equal(out.code, 404);
  assert.match(JSON.parse(out.body).error, /no stored recordings/);
});

test("clip: 409 until a push names a recording", async () => {
  const { handler, ctx, calls } = setup();
  ctx.noteRecording({ deviceSn: "CAM1", payload: {} }); // no recording, no cipher
  const out = await get(handler);
  assert.equal(out.code, 409);
  assert.equal(calls.download.length, 0);
});

test("clip: downloads the pushed recording under its cipher and serves the mp4", async () => {
  const { handler, ctx, calls, dir } = setup();
  ctx.noteRecording(PUSH);
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.headers["content-type"], "video/mp4");
  assert.equal(out.body.toString(), "MP4:V");
  assert.deepEqual(calls.download, [{ recording: "20260101120000", cipherId: 241 }]);
  assert.deepEqual(fs.readdirSync(dir), ["last-clip-CAM1.mp4"]); // no leftover temp file
});

test("clip: waits until the settle time has passed since the push", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { handler, ctx, calls } = setup({ settleMs: "30000" });
  ctx.noteRecording(PUSH);
  const pending = get(handler);
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(29_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.download.length, 0); // the station may still be writing it
  t.mock.timers.tick(1_000);
  assert.equal((await pending).code, 200);
  assert.equal(calls.download.length, 1);
});

test("clip: the same recording is served again without a second download, a new one is fetched", async () => {
  const { handler, ctx, calls } = setup({ download: async (o) => ({ video: Buffer.from(o.recording) }) });
  ctx.noteRecording(PUSH);
  const [a, b] = await Promise.all([get(handler), get(handler)]);
  assert.equal((await get(handler)).body.toString(), "MP4:20260101120000");
  assert.deepEqual([a.code, b.code], [200, 200]);
  assert.equal(calls.download.length, 1); // two concurrent callers and a later one share one download
  ctx.noteRecording({ ...PUSH, payload: { p: "20260101120500" } });
  assert.equal((await get(handler)).body.toString(), "MP4:20260101120500");
  assert.equal(calls.download.length, 2);
});

test("clip: a failed download answers 502 with the SDK's reason, and the next request tries again", async () => {
  let fail = true;
  const { handler, ctx, calls } = setup({
    download: async () => {
      if (fail) throw Object.assign(new Error("transfer ended early"), { reason: "incomplete" });
      return { video: Buffer.from("V") };
    },
  });
  ctx.noteRecording(PUSH);
  const out = await get(handler);
  assert.equal(out.code, 502);
  assert.equal(JSON.parse(out.body).reason, "incomplete");
  fail = false;
  assert.equal((await get(handler)).code, 200);
  assert.equal(calls.download.length, 2);
});
