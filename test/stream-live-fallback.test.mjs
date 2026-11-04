// /stream on a camera-capable device the SDK withholds `openReadable` from (#166).
//
// The SDK gates `openReadable` on codec "camera", so the T8530 Video Smart Lock (codec "lock", caps
// ["camera"]) has only the ungated `live()`. /stream answered 404 "no live video on this device" for it, so
// go2rtc got nothing. It must fall back to `live()` and serve the same Annex-B bytes.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { readableFromLive } from "../src/live-feed.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0"; // no real HTTP at :1984 from the consumer probe
const { createHttpHandler } = await import("../src/http-routes.mjs");

/** A stand-in for the SDK's LiveStreamConsumer: emits `video` frames, honors pause/resume/stop. */
class FakeConsumer extends EventEmitter {
  paused = false;
  stopped = 0;
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  stop() {
    this.stopped++;
  }
  frame(bytes) {
    this.emit("video", { data: Buffer.from(bytes), keyframe: false });
  }
}

async function until(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** A bridge HTTP server over one fake device whose camera surface is `camera`. */
async function setup(camera, env = {}) {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", ...env });
  const state = createState();
  state.flags.ready = true;
  const t = { state, broadcasts: [] };
  const ctx = {
    ...config,
    state,
    eventImageDir: undefined,
    eventLog: () => {},
    broadcast: (msg) => void t.broadcasts.push(msg),
    noteStreamOpened: () => {},
    noteStreamFailure: () => {},
    streamBackoffMs: () => 0,
    dropStreamClient: () => {},
    streamClientFor: async () => ({
      getDevice: async () => ({ describe: () => ({ model: "T8530", capabilities: ["camera"] }), camera: () => camera }),
    }),
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

/** GET /stream/LOCK1; resolves with the response once its headers arrive. Body chunks collect in `body`. */
function get(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/stream/LOCK1" }, (res) => {
      res.body = [];
      res.on("data", (c) => res.body.push(c));
      res.ended = new Promise((r) => res.on("end", r));
      res.req = req;
      resolve(res);
    });
    req.on("error", reject);
  });
}

test("a camera with live() but no openReadable streams instead of answering 404", async () => {
  const consumer = new FakeConsumer();
  const opened = [];
  const t = await setup(
    {
      live: async (opts) => {
        opened.push(opts);
        return consumer;
      },
    },
    { STREAM_BATTERY_BUDGET_MS: "180000" },
  );
  try {
    const pending = get(t.port); // headers flush with the first frame, so don't await before sending one
    await until(() => t.state.streaming.has("LOCK1"), "the lock to read as streaming");
    assert.equal(opened[0]?.batteryBudgetMs, 180000); // the budget reaches live() like it reached openReadable()
    consumer.frame("\x00\x00\x00\x01AU1");
    const res = await pending;
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/octet-stream");
    consumer.frame("\x00\x00\x00\x01AU2");
    consumer.emit("stop"); // the shared source ended → the response ends cleanly
    await res.ended;
    assert.equal(Buffer.concat(res.body).toString("latin1"), "\x00\x00\x00\x01AU1\x00\x00\x00\x01AU2");
    await until(() => !t.state.streaming.has("LOCK1"), "the lock to read as idle once the feed ended");
    assert.ok(consumer.stopped >= 1, "the consumer is detached from the shared source");
  } finally {
    await t.close();
  }
});

test("a viewer leaving stops the live() consumer", async () => {
  const consumer = new FakeConsumer();
  const t = await setup({ live: async () => consumer });
  try {
    const pending = get(t.port);
    await until(() => t.state.streaming.has("LOCK1"), "the lock to read as streaming");
    consumer.frame("\x00\x00\x00\x01AU1");
    const res = await pending;
    assert.equal(res.statusCode, 200);
    await until(() => res.body.length > 0, "the first frame to arrive");
    res.req.destroy();
    await until(() => consumer.stopped >= 1, "the consumer to be stopped");
    await until(() => !t.state.streaming.has("LOCK1"), "the lock to read as idle");
  } finally {
    await t.close();
  }
});

test("openReadable is still preferred when the SDK offers it", async () => {
  let lives = 0;
  const feed = new PassThrough();
  const t = await setup({
    openReadable: async () => feed,
    live: async () => {
      lives++;
      return new FakeConsumer();
    },
  });
  try {
    const pending = get(t.port);
    await until(() => t.state.streaming.has("LOCK1"), "the lock to read as streaming");
    feed.end(Buffer.from("AU"));
    const res = await pending;
    assert.equal(res.statusCode, 200);
    await res.ended;
    assert.equal(Buffer.concat(res.body).toString(), "AU");
    assert.equal(lives, 0);
  } finally {
    await t.close();
  }
});

test("a device with neither still answers 404", async () => {
  const t = await setup({ snapshotStored: async () => Buffer.alloc(0) });
  try {
    const res = await get(t.port);
    await res.ended;
    assert.equal(res.statusCode, 404);
    assert.match(Buffer.concat(res.body).toString(), /no live video on this device/);
  } finally {
    await t.close();
  }
});

test("readableFromLive pauses the consumer under backpressure and resumes it on read", async () => {
  const consumer = new FakeConsumer();
  const readable = readableFromLive(consumer);
  consumer.frame(Buffer.alloc(64 * 1024)); // past the 16 KiB highWaterMark with nobody reading
  assert.equal(consumer.paused, true);
  readable.read();
  await new Promise((r) => setImmediate(r));
  assert.equal(consumer.paused, false);

  const budget = new Promise((r) => readable.once("budget", r));
  consumer.emit("budget", { graceMs: 10000 });
  assert.deepEqual(await budget, { graceMs: 10000 });

  const failed = new Promise((r) => readable.once("error", r));
  consumer.emit("error", new Error("warm-timeout"));
  assert.equal((await failed).message, "warm-timeout");
  assert.equal(consumer.stopped, 1);
});
