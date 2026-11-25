// Live audio (LIVE_AUDIO=1): /audio/<sn> serves the camera's AAC-LC frames as an ADTS stream that go2rtc
// merges into the camera's stream. go2rtc dials the audio and video sources together in no set order, so
// /audio goes through the same per-camera client and joins the SDK's shared live source. It honours the
// same battery guards as /stream, is closed if no video feed joins it, and ends with the last video feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { audioReadableFromLive } from "../src/live-audio.mjs";
import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0"; // no real HTTP at :1984 from the consumer probe
const { createHttpHandler } = await import("../src/http-routes.mjs");

const ADTS_A = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x01, 0x1f, 0xfc, 0xaa]);
const ADTS_B = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x01, 0x1f, 0xfc, 0xbb]);

function fakeConsumer() {
  const c = new EventEmitter();
  c.stopped = 0;
  c.stop = () => {
    c.stopped++;
    c.emit("stop");
  };
  return c;
}

async function until(cond, what) {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

// ── the Readable ───────────────────────────────────────────────────────────────────────────────────

test("only AAC-LC frames are forwarded, others reported once", async () => {
  const consumer = fakeConsumer();
  const unsupported = [];
  const r = audioReadableFromLive(consumer, { onUnsupported: (c) => unsupported.push(c) });
  const chunks = [];
  r.on("data", (d) => chunks.push(d));
  consumer.emit("video", { data: Buffer.from([0, 0, 0, 1]) });
  consumer.emit("audio", { codec: "aac-lc", data: ADTS_A });
  consumer.emit("audio", { codec: "g711a", data: Buffer.from([1, 2]) });
  consumer.emit("audio", { codec: "g711a", data: Buffer.from([3, 4]) });
  consumer.emit("audio", { codec: "aac-lc", data: ADTS_B });
  consumer.emit("stop");
  await new Promise((res) => r.on("end", res));
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([ADTS_A, ADTS_B]));
  assert.deepEqual(unsupported, ["g711a"]);
});

test("destroying the Readable stops the consumer", () => {
  const consumer = fakeConsumer();
  const r = audioReadableFromLive(consumer);
  r.destroy();
  assert.equal(consumer.stopped, 1);
});

// ── go2rtc config ──────────────────────────────────────────────────────────────────────────────────

async function generate(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go2rtc-"));
  const file = path.join(dir, "go2rtc.yaml");
  const devices = [
    { sn: "CAM1", stream: "/stream/CAM1" },
    {
      sn: "DUAL",
      stream: "/stream/DUAL",
      views: [
        { id: "DUAL", stream: "/stream/DUAL" },
        { id: "DUAL_view_1", stream: "/stream/DUAL?view=1" },
      ],
    },
  ];
  await writeGo2rtcConfig({ selfHost: "127.0.0.1", port: 3000, go2rtcConfig: file, ...extra }, devices);
  return fs.readFileSync(file, "utf8");
}

test("without LIVE_AUDIO the go2rtc sources are unchanged (video only)", async () => {
  const yaml = await generate({});
  assert.ok(yaml.includes("  CAM1: ffmpeg:http://127.0.0.1:3000/stream/CAM1#video=copy#async\n"));
  assert.ok(!yaml.includes("/audio/"));
});

test("with LIVE_AUDIO each main view gets an AAC/Opus audio source", async () => {
  const yaml = await generate({ liveAudio: true });
  assert.ok(
    yaml.includes(
      "  CAM1:\n" +
        "    - ffmpeg:http://127.0.0.1:3000/stream/CAM1#video=copy#async\n" +
        "    - ffmpeg:http://127.0.0.1:3000/audio/CAM1#audio=aac#audio=opus#async#input=eufy_aac\n",
    ),
  );
  assert.ok(yaml.includes('  eufy_aac: "-analyzeduration 0 -probesize 4096 -f aac -i {input}"'));
  // secondary optical views stay video-only: one audio track per camera
  assert.ok(yaml.includes("  DUAL_view_1: ffmpeg:http://127.0.0.1:3000/stream/DUAL?view=1#video=copy#async\n"));
});

test("LIVE_AUDIO is off by default and parsed from the environment", () => {
  const base = { EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" };
  assert.equal(loadConfig(base).cfg.liveAudio, false);
  assert.equal(loadConfig({ ...base, LIVE_AUDIO: "1" }).cfg.liveAudio, true);
  assert.equal(loadConfig({ ...base, LIVE_AUDIO_WAIT_MS: "500" }).cfg.liveAudioWaitMs, 500);
});

// ── the /audio route ───────────────────────────────────────────────────────────────────────────────

async function setup(env = {}) {
  const config = loadConfig({
    EUFY_EMAIL: "x@y.z",
    EUFY_PASSWORD: "pw",
    LIVE_AUDIO: "1",
    LIVE_AUDIO_WAIT_MS: "300",
    ...env,
  });
  const state = createState();
  state.flags.ready = true;
  const t = { feeds: [], consumers: [], clientsMade: 0 };
  const client = {
    getDevice: async () => ({
      camera: () => ({
        openReadable: async () => {
          const feed = new PassThrough();
          t.feeds.push(feed);
          return feed;
        },
        live: async () => {
          const c = fakeConsumer();
          t.consumers.push(c);
          return c;
        },
      }),
    }),
  };
  const ctx = (t.ctx = {
    ...config,
    state,
    eventImageDir: undefined,
    eventLog: () => {},
    broadcast: () => {},
    noteStreamOpened: () => {},
    noteStreamFailure: () => {},
    streamBackoffMs: () => 0,
    dropStreamClient: () => {},
    streamClientFor: () => {
      t.clientsMade++;
      return Promise.resolve(client);
    },
  });
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

function get(t, p) {
  const out = { status: undefined, body: [], ended: false };
  out.req = http.get({ host: "127.0.0.1", port: t.port, path: p });
  out.done = new Promise((resolve) => {
    out.req.on("response", (res) => {
      out.status = res.statusCode;
      out.type = res.headers["content-type"];
      res.on("data", (d) => out.body.push(d));
      res.on("end", () => ((out.ended = true), resolve()));
      res.on("aborted", resolve);
      res.on("error", resolve);
    });
    out.req.on("error", resolve);
  });
  return out;
}

test("/audio is 404 when LIVE_AUDIO is off", async () => {
  const t = await setup({ LIVE_AUDIO: "0" });
  const a = get(t, "/audio/CAM1");
  await a.done;
  assert.equal(a.status, 404);
  await t.close();
});

test("/audio on an idle-suspended or backing-off camera answers 503 and wakes nothing", async () => {
  const t = await setup();
  t.ctx.state.idleSuspended.add("CAM1");
  const a = get(t, "/audio/CAM1");
  await a.done;
  assert.equal(a.status, 503);
  t.ctx.state.idleSuspended.delete("CAM1");
  t.ctx.streamBackoffMs = () => 5000;
  const b = get(t, "/audio/CAM1");
  await b.done;
  assert.equal(b.status, 503);
  assert.equal(t.clientsMade, 0);
  assert.equal(t.consumers.length, 0);
  await t.close();
});

test("/audio opened before /stream works, but is closed if no video feed joins", async () => {
  const t = await setup(); // LIVE_AUDIO_WAIT_MS=300
  const a = get(t, "/audio/CAM1");
  await until(() => a.status === 200, "audio response headers");
  assert.equal(t.consumers.length, 1);
  await a.done; // nobody opened /stream → the orphan guard ends it
  await until(() => t.consumers[0].stopped > 0, "orphan audio consumer stopped");
  await t.close();
});

test("/audio rides the /stream session, serves ADTS, and ends with the video", async () => {
  const t = await setup();
  const v = get(t, "/stream/CAM1");
  const a = get(t, "/audio/CAM1"); // opened together, like go2rtc does
  await until(() => t.consumers.length === 1 && t.feeds.length === 1, "audio and video attached");
  await until(() => a.status === 200, "audio response headers");
  assert.equal(a.type, "audio/aac");
  t.consumers[0].emit("audio", { codec: "aac-lc", data: ADTS_A });
  await until(() => a.body.length > 0, "audio bytes");
  assert.deepEqual(Buffer.concat(a.body), ADTS_A);
  // the last video feed ends → audio ends too, and its consumer is detached
  v.req.destroy();
  await a.done;
  await until(() => t.consumers[0].stopped > 0, "audio consumer stopped");
  await t.close();
});

test("a viewer leaving /audio detaches only the audio consumer", async () => {
  const t = await setup();
  const v = get(t, "/stream/CAM1");
  await until(() => t.feeds.length === 1, "video feed open");
  const a = get(t, "/audio/CAM1");
  await until(() => a.status === 200, "audio response headers");
  a.req.destroy();
  await until(() => t.consumers[0].stopped > 0, "audio consumer stopped");
  assert.equal(t.feeds[0].destroyed, false, "the video feed keeps running");
  v.req.destroy();
  await t.close();
});
