// /audio/<sn> over a real loopback HTTP connection.
//
// - It serves the camera's live() audio as ADTS (`audio/aac`), and never opens the video-only openReadable().
// - A camera with no aac-lc audio answers 404 without arming the failure backoff or dropping its client:
//   its video is fine, and /stream on the same client must keep working.
// - The viewer leaving releases the live() consumer and clears the camera's streaming state, like /stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";

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

/** A bridge HTTP server over a fake camera whose live() hands out the handles the test drives. */
async function setup({ live = true } = {}) {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" });
  const state = createState();
  state.flags.ready = true;
  const t = { state, broadcasts: [], handles: [], readableOpens: 0, dropped: [], failures: [] };
  const camera = {
    openReadable: async () => void t.readableOpens++,
    ...(live && {
      live: async () => {
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
    eventImageDir: undefined,
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
function pull(t) {
  const out = { chunks: [], ended: false };
  out.req = http.get({ host: "127.0.0.1", port: t.port, path: "/audio/CAM1" });
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
