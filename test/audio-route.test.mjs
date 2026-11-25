// /audio/<sn> over a real loopback HTTP connection.
//
// - It serves the camera's live() audio as ADTS (`audio/aac`), and never opens the video-only openReadable().
// - A camera with no aac-lc audio answers 404 without arming the failure backoff or dropping its client:
//   its video is fine, and /stream on the same client must keep working.
// - The viewer leaving releases the live() consumer and clears the camera's streaming state, like /stream.
// - Cold start: a camera whose live audio format is kept answers at once with silence in that format, then its
//   live audio; a different live format ends the response (go2rtc reconnects), and a camera shown to have no
//   aac-lc audio loses its kept format so its next request can answer 404.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { saveAudioFormat, loadAudioFormat, silentAdtsFrame } from "../src/audio-primer.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0"; // no real HTTP at :1984 from the consumer probe
const { createHttpHandler } = await import("../src/http-routes.mjs");

/** Resolves once `cond()` holds, polling the event loop (fails the test after ~2s). */
async function until(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** `promise`, or a test failure after ~2s: a response that should end but does not fails instead of hanging. */
function within(promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for: ${what}`)), 2000);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A bridge HTTP server over a fake camera whose live() hands out the handles the test drives. */
async function setup({ live = true, views = [0], outputs = [], dir, env = {} } = {}) {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", ...env });
  const state = createState();
  state.flags.ready = true;
  const t = { state, broadcasts: [], handles: [], readableOpens: 0, dropped: [], failures: [] };
  const camera = {
    views: () => views,
    ...(outputs.length ? { outputResolutions: () => outputs } : {}),
    openReadable: async () => void t.readableOpens++,
    ...(live && {
      live: async (opts) => {
        t.lastLiveOptions = opts;
        const h = new EventEmitter();
        h.stops = 0;
        h.stop = () => void h.stops++;
        t.handles.push(h);
        return h;
      },
    }),
  };
  const ctx = {
    ...config,
    state,
    eventImageDir: dir,
    eventLog: () => {},
    broadcast: (msg) => void t.broadcasts.push(msg),
    noteStreamOpened: () => {},
    noteStreamFailure: (sn) => void t.failures.push(sn),
    streamBackoffMs: () => 0,
    dropStreamClient: (sn) => void t.dropped.push(sn),
    streamClientFor: async () => ({ getDevice: async () => ({ camera: () => camera }) }),
  };
  const handler = createHttpHandler(ctx);
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.port = server.address().port;
  t.close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  };
  return t;
}

/** Open /audio/CAM1 and collect what arrives. */
function pull(t, query = "") {
  const out = { chunks: [], ended: false };
  out.req = http.get({ host: "127.0.0.1", port: t.port, path: `/audio/CAM1${query}` });
  out.done = new Promise((resolve) => {
    out.req.on("response", (res) => {
      out.status = res.statusCode;
      out.type = res.headers["content-type"];
      res.on("data", (c) => out.chunks.push(c));
      res.on("end", () => resolve(out));
      res.on("aborted", () => resolve(out));
      res.on("error", () => resolve(out));
    });
    out.req.on("error", () => resolve(out));
  });
  out.hex = () => Buffer.concat(out.chunks).toString("hex");
  return out;
}

test("/audio serves the camera's aac-lc frames as ADTS, through live() and not openReadable()", async () => {
  const t = await setup();
  try {
    const p = pull(t);
    await until(() => t.handles.length === 1, "live() consumer attached");
    const h = t.handles[0];
    h.emit("audio", { codec: "aac-lc", data: Buffer.from("fff1aa", "hex") });
    h.emit("audio", { codec: "aac-lc", data: Buffer.from("fff1bb", "hex") });
    await until(() => p.hex() === "fff1aafff1bb", "both frames delivered");
    assert.equal(p.status, 200);
    assert.equal(p.type, "audio/aac");
    assert.equal(t.readableOpens, 0, "the video-only egress is not opened for audio");
    assert.ok(t.state.streaming.has("CAM1"), "an audio pull counts as the camera streaming");
    h.emit("stop");
    await p.done;
    await until(() => !t.state.streaming.has("CAM1"), "streaming cleared");
  } finally {
    await t.close();
  }
});

test("a camera with no aac-lc audio answers 404, and the camera is not counted as failed", async () => {
  const t = await setup();
  try {
    const p = pull(t);
    await until(() => t.handles.length === 1, "live() consumer attached");
    t.handles[0].emit("audio", { codec: "g711a", data: Buffer.from("00", "hex") });
    const out = await p.done;
    assert.equal(out.status, 404);
    assert.match(Buffer.concat(out.chunks).toString(), /g711a/, "the 404 says why");
    assert.equal(t.handles[0].stops, 1, "the consumer is released");
    assert.deepEqual(t.failures, [], "no failure backoff: the camera's video is fine");
    assert.deepEqual(t.dropped, [], "the client stays: /stream keeps using it");
    assert.equal(t.state.streaming.has("CAM1"), false);
  } finally {
    await t.close();
  }
});

test("the viewer leaving releases the live() consumer", async () => {
  const t = await setup();
  try {
    const p = pull(t);
    await until(() => t.handles.length === 1, "live() consumer attached");
    const h = t.handles[0];
    h.emit("audio", { codec: "aac-lc", data: Buffer.from("fff1", "hex") });
    await until(() => p.chunks.length > 0, "first frame delivered");
    p.req.destroy();
    await until(() => h.stops === 1, "consumer stopped");
    await until(() => !t.state.streaming.has("CAM1"), "streaming cleared");
    assert.equal(t.broadcasts.filter((b) => b.event === "streamState" && b.active === false).length, 1);
  } finally {
    await t.close();
  }
});

test("a device without live() answers 404 for audio", async () => {
  const t = await setup({ live: false });
  try {
    const out = await pull(t).done;
    assert.equal(out.status, 404);
    assert.match(Buffer.concat(out.chunks).toString(), /no live audio on this device/);
  } finally {
    await t.close();
  }
});

test("secondary audio forwards its advertised view and releases that consumer", async () => {
  const t = await setup({ views: [0, 1] });
  try {
    const p = pull(t, "?view=1");
    await until(() => t.handles.length === 1, "secondary audio attached");
    assert.equal(t.lastLiveOptions.view, 1);
    t.handles[0].emit("audio", { codec: "aac-lc", data: Buffer.from("fff1aa", "hex") });
    await until(() => p.chunks.length > 0, "secondary audio served");
    assert.equal(p.status, 200);
    p.req.destroy();
    await until(() => t.handles[0].stops === 1, "secondary audio released");
  } finally {
    await t.close();
  }
});

test("an unadvertised audio view stays a 404 without opening live media", async () => {
  const t = await setup();
  try {
    const p = await pull(t, "?view=1").done;
    assert.equal(p.status, 404);
    assert.equal(t.handles.length, 0);
  } finally {
    await t.close();
  }
});

// A T8200's live audio: AAC-LC, 16 kHz, stereo (its first ADTS header on 17 Nov 2026, then frame bytes).
const STEREO = { mpeg2: 0, profile: 1, rateIndex: 8, channels: 2 };
const LIVE_FRAME = Buffer.from("fff16080181ffc211a", "hex");
const MONO_FRAME = Buffer.from("fff16040181ffc211a", "hex");
const SILENCE = silentAdtsFrame(STEREO).toString("hex");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "audio-route-"));
}

test("cold start: a kept format answers at once with matching silence, then the live audio", async () => {
  const dir = tmpDir();
  await saveAudioFormat(dir, "CAM1", STEREO);
  const t = await setup({ dir });
  try {
    const p = pull(t);
    // Before the camera has sent anything: go2rtc already has headers and an ADTS header to read.
    await until(() => p.chunks.length > 0, "silence before any live frame");
    assert.equal(p.status, 200);
    assert.equal(p.type, "audio/aac");
    assert.ok(p.hex().startsWith(SILENCE));
    await until(() => t.handles.length === 1, "live() consumer attached");
    const h = t.handles[0];
    h.emit("audio", { codec: "aac-lc", data: LIVE_FRAME });
    await until(() => p.hex().endsWith(LIVE_FRAME.toString("hex")), "live audio follows the silence");
    assert.equal(p.hex().replaceAll(SILENCE, "").length, LIVE_FRAME.length * 2, "nothing but silence before it");
    const silentNow = p.hex().split(SILENCE).length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(p.hex().split(SILENCE).length, silentNow, "no silence once the live audio runs");
    h.emit("stop");
    await p.done;
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cold start: no kept format waits for the camera as before, and keeps the format it sends", async () => {
  const dir = tmpDir();
  const t = await setup({ dir });
  try {
    const p = pull(t);
    await until(() => t.handles.length === 1, "live() consumer attached");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.status, undefined, "no answer before the camera's first frame");
    t.handles[0].emit("audio", { codec: "aac-lc", data: LIVE_FRAME });
    await until(() => p.hex() === LIVE_FRAME.toString("hex"), "the live frame, with no silence");
    // Kept before the frame is written, so it is on disk by now.
    assert.deepEqual(await loadAudioFormat(dir, "CAM1"), STEREO);
    t.handles[0].emit("stop");
    await p.done;
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cold start: live audio in another format ends the primed response and replaces the kept format", async () => {
  const dir = tmpDir();
  await saveAudioFormat(dir, "CAM1", STEREO);
  const t = await setup({ dir });
  try {
    const p = pull(t);
    await until(() => t.handles.length === 1, "live() consumer attached");
    t.handles[0].emit("audio", { codec: "aac-lc", data: MONO_FRAME });
    await within(p.done, "the primed response to end");
    assert.equal(p.status, 200);
    assert.ok(!p.hex().includes(MONO_FRAME.toString("hex")), "mono never follows stereo silence");
    assert.equal(t.handles[0].stops, 1, "the consumer is released");
    assert.equal((await loadAudioFormat(dir, "CAM1")).channels, 1, "the next request primes in mono");
    await until(() => !t.state.streaming.has("CAM1"), "not left streaming");
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cold start: a primed camera that turns out to send no aac-lc forgets its format", async () => {
  const dir = tmpDir();
  await saveAudioFormat(dir, "CAM1", STEREO);
  const t = await setup({ dir });
  try {
    const p = pull(t);
    await until(() => t.handles.length === 1, "live() consumer attached");
    t.handles[0].emit("audio", { codec: "g711a", data: Buffer.from("00", "hex") });
    await within(p.done, "the primed response to end");
    assert.equal(p.status, 200, "already primed: the response ends instead of a 404");
    assert.equal(await loadAudioFormat(dir, "CAM1"), null, "so the next request waits and can answer 404");
    assert.deepEqual(t.failures, [], "no failure backoff: the camera's video is fine");
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, opts, query] of [
  ["a secondary view", { views: [0, 1] }, "?view=1"],
  ["STREAM_INSTANT_START=0", { env: { STREAM_INSTANT_START: "0" } }, ""],
]) {
  test(`cold start: ${name} is never primed`, async () => {
    const dir = tmpDir();
    await saveAudioFormat(dir, "CAM1", STEREO);
    await saveAudioFormat(dir, "CAM1_view_1", STEREO);
    const t = await setup({ dir, ...opts });
    try {
      const p = pull(t, query);
      await until(() => t.handles.length === 1, "live() consumer attached");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(p.status, undefined, "no answer before the camera's first frame");
      p.req.destroy();
    } finally {
      await t.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
test("Full HD audio forwards the selected output and optic and releases only its consumer", async () => {
  const t = await setup({ views: [0, 1], outputs: ["1080p"] });
  try {
    const p = pull(t, "?view=1&outputResolution=1080p");
    await until(() => t.handles.length === 1, "Full HD secondary audio attached");
    assert.equal(t.lastLiveOptions.view, 1);
    assert.equal(t.lastLiveOptions.outputResolution, "1080p");
    t.handles[0].emit("audio", { codec: "aac-lc", data: Buffer.from("fff1aa", "hex") });
    await until(() => p.chunks.length > 0, "Full HD secondary audio served");
    assert.equal(p.status, 200);
    p.req.destroy();
    await until(() => t.handles[0].stops === 1, "Full HD audio released");
    assert.deepEqual(t.failures, []);
  } finally {
    await t.close();
  }
});

test("unsupported or malformed audio output selections fail before opening live media", async () => {
  const t = await setup({ views: [0, 1] });
  try {
    for (const [query, expected] of [
      ["?view=1&outputResolution=1080p", 404],
      ["?view=1&outputResolution=4K", 400],
      ["?outputResolution=1080p&outputResolution=1080p", 400],
    ]) {
      assert.equal((await pull(t, query).done).status, expected);
    }
    assert.equal(t.handles.length, 0);
    assert.deepEqual(t.failures, []);
  } finally {
    await t.close();
  }
});
