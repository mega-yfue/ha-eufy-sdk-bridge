// /stream answers at once with the camera's last live keyframe while a sleeping camera wakes, and retries a
// failed open once before giving up.
//
// - A consumer's RTSP client (Home Assistant's go2rtc) waits a fixed 5 s for the DESCRIBE reply, which go2rtc
//   here can give only once its ffmpeg has seen the first frames. A battery camera needs longer than that to
//   wake, so the response must start with the kept keyframe and keep repeating it until the live feed arrives.
// - Without a kept keyframe (never watched) or with the feature off, /stream behaves as before.
// - A primed response cannot turn into a 502 any more: a final failure aborts it, and still arms the backoff.
// - A failed first open usually woke the camera, so one more attempt on a fresh session follows at once; a
//   primed request goes on retrying for the open budget (a 4G camera can need over a minute).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createLiveStillTap, lastLiveKeyframeFile } from "../src/live-still.mjs";
import { loadPrimer } from "../src/stream-primer.mjs";
import { PLACEHOLDER_KEYFRAME } from "../src/stream-placeholder.mjs";
import { streamClientOptions } from "../streams.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0"; // no real HTTP at :1984 from the consumer probe
const { createHttpHandler } = await import("../src/http-routes.mjs");

// A minimal H.264 keyframe access unit: SPS, PPS, IDR slice.
const KEYFRAME = Buffer.from([
  0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80, 0, 0, 0, 1, 0x65, 0x88,
]);

async function until(cond, what) {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/**
 * A bridge HTTP server over fake cameras. Each open takes the next entry of `t.plan` ("fail" or "feed";
 * default "feed") and waits on `t.gate` when set. `env` extends the bridge environment.
 */
async function setup({ env = {}, keyframe = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instant-start-"));
  if (keyframe) fs.writeFileSync(lastLiveKeyframeFile(dir, "CAM1"), KEYFRAME);
  const config = loadConfig({
    EUFY_EMAIL: "x@y.z",
    EUFY_PASSWORD: "pw",
    STREAM_PRIMER_MS: "20",
    STREAM_OPEN_RETRY_PAUSE_MS: "5",
    STREAM_PLACEHOLDER: "0", // the stand-in picture has its own tests below
    ...env,
  });
  const state = createState();
  state.flags.ready = true;
  const t = { state, feeds: [], opens: 0, clients: 0, dropped: [], failures: [], plan: [], gate: null, log: [] };
  const ctx = {
    ...config,
    state,
    eventImageDir: dir,
    eventLog: (line) => void t.log.push(line),
    broadcast: () => {},
    noteStreamOpened: () => {},
    noteStreamFailure: (sn) => void t.failures.push(sn),
    streamBackoffMs: () => 0,
    dropStreamClient: (sn) => void t.dropped.push(sn),
    streamClientFor: async () => {
      t.clients++;
      return {
        getDevice: async () => ({
          camera: () => ({
            openReadable: async () => {
              const step = t.plan[t.opens++] ?? "feed";
              if (step === "error") throw new Error("cloud said no");
              if (t.gate) await t.gate;
              if (step === "fail") throw new Error("P2P connect timeout");
              const feed = new PassThrough();
              t.feeds.push(feed);
              return feed;
            },
          }),
        }),
      };
    },
  };
  const server = http.createServer((req, res) => void createHttpHandler(ctx)(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.port = server.address().port;
  t.dir = dir;
  t.close = () => {
    server.closeAllConnections();
    fs.rmSync(dir, { recursive: true, force: true });
    return new Promise((r) => server.close(r));
  };
  return t;
}

/** Open /stream/CAM1 and collect every byte; `done` settles with how the response ended. */
function pull(t) {
  const out = { chunks: [], ended: false, aborted: false };
  out.bytes = () => Buffer.concat(out.chunks);
  out.req = http.get({ host: "127.0.0.1", port: t.port, path: "/stream/CAM1" });
  out.done = new Promise((resolve) => {
    out.req.on("response", (res) => {
      out.status = res.statusCode;
      res.on("data", (c) => out.chunks.push(c));
      res.on("end", () => resolve(Object.assign(out, { ended: true })));
      res.on("aborted", () => resolve(Object.assign(out, { aborted: true })));
      res.on("error", () => resolve(Object.assign(out, { aborted: true })));
    });
    out.req.on("error", () => resolve(Object.assign(out, { aborted: true })));
  });
  return out;
}

/** How many whole copies of the keyframe `buf` starts with. */
function leadingKeyframes(buf) {
  let n = 0;
  while (
    buf.length >= (n + 1) * KEYFRAME.length &&
    buf.subarray(n * KEYFRAME.length, (n + 1) * KEYFRAME.length).equals(KEYFRAME)
  )
    n++;
  return n;
}

test("a kept keyframe answers /stream at once and repeats until the live feed takes over", async () => {
  const t = await setup();
  try {
    let release;
    t.gate = new Promise((r) => (release = r));
    const p = pull(t);
    await until(() => p.status === 200, "headers sent before the camera is up");
    await until(() => leadingKeyframes(p.bytes()) >= 3, "the keyframe repeated while the camera wakes");
    release();
    await until(() => t.feeds.length === 1, "live feed opened");
    const primed = p.bytes().length;
    const live = Buffer.from("live-bytes");
    t.feeds[0].end(live);
    const out = await p.done;
    assert.equal(out.ended, true);
    const body = out.bytes();
    assert.equal(primed % KEYFRAME.length, 0, "only whole keyframes before the live feed");
    assert.ok(body.subarray(body.length - live.length).equals(live), "the live feed follows");
    assert.ok(
      t.log.some((l) => l.includes("answered at once")),
      "logged",
    );
  } finally {
    await t.close();
  }
});

test("without a kept keyframe /stream waits for the feed, as before", async () => {
  const t = await setup({ keyframe: false });
  try {
    let release;
    t.gate = new Promise((r) => (release = r));
    const p = pull(t);
    await until(() => t.opens === 1, "open in progress");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(p.status, undefined, "no answer before the camera is up");
    release();
    await until(() => t.feeds.length === 1, "live feed opened");
    t.feeds[0].end(Buffer.from("x"));
    const out = await p.done;
    assert.equal(out.status, 200);
    assert.equal(out.bytes().toString(), "x");
  } finally {
    await t.close();
  }
});

test("STREAM_INSTANT_START=0 ignores a kept keyframe", async () => {
  const t = await setup({ env: { STREAM_INSTANT_START: "0" } });
  try {
    const p = pull(t);
    await until(() => t.feeds.length === 1, "live feed opened");
    t.feeds[0].end(Buffer.from("x"));
    const out = await p.done;
    assert.equal(out.bytes().toString(), "x");
  } finally {
    await t.close();
  }
});

test("a primed stream whose open finally fails is aborted, and arms the backoff once", async () => {
  const t = await setup({ env: { STREAM_OPEN_ATTEMPTS: "2", STREAM_OPEN_BUDGET_MS: "1" } });
  try {
    t.plan = ["fail", "fail"];
    t.gate = new Promise((r) => setTimeout(r, 100)); // a real failed connect takes 15 s, not 0
    const p = pull(t);
    const out = await p.done;
    assert.equal(out.status, 200);
    assert.equal(out.aborted, true, "the response dies instead of ending cleanly");
    assert.ok(leadingKeyframes(out.bytes()) >= 1);
    assert.equal(t.opens, 2, "tried twice");
    assert.deepEqual(t.failures, ["CAM1"], "one failure for the request, not one per attempt");
    assert.deepEqual(t.dropped, ["CAM1", "CAM1"], "neither failed session is reused");
  } finally {
    await t.close();
  }
});

test("a failed first open is retried at once on a fresh session", async () => {
  const t = await setup({ keyframe: false });
  try {
    t.plan = ["fail", "feed"];
    const p = pull(t);
    await until(() => t.feeds.length === 1, "second attempt opened the feed");
    t.feeds[0].end(Buffer.from("live"));
    const out = await p.done;
    assert.equal(out.status, 200);
    assert.equal(out.bytes().toString(), "live");
    assert.equal(t.clients, 2, "the retry built a new client");
    assert.deepEqual(t.dropped, ["CAM1"], "the failed session was dropped");
    assert.deepEqual(t.failures, [], "a request that succeeded arms no backoff");
    assert.ok(
      t.log.some((l) => l.includes("open attempt 1/3 failed")),
      "logged",
    );
  } finally {
    await t.close();
  }
});

test("a primed request keeps retrying past STREAM_OPEN_ATTEMPTS until the open budget is spent", async () => {
  // A 4G camera can need over a minute to wake; giving up after the attempts would arm the backoff and
  // refuse the consumer's reconnects just as the camera comes up.
  const t = await setup({ env: { STREAM_OPEN_ATTEMPTS: "1", STREAM_OPEN_BUDGET_MS: "60000" } });
  try {
    t.plan = ["fail", "fail", "fail", "fail", "feed"];
    const p = pull(t);
    await until(() => t.feeds.length === 1, "the fifth attempt opened the feed");
    t.feeds[0].end(Buffer.from("live"));
    const out = await p.done;
    assert.equal(out.ended, true);
    assert.equal(out.bytes().subarray(-4).toString(), "live");
    assert.equal(t.opens, 5);
    assert.deepEqual(t.failures, [], "no backoff armed");
    assert.ok(
      t.log.some((l) => l.includes("not reachable yet") && l.includes("attempt 4, primed")),
      "logged",
    );
  } finally {
    await t.close();
  }
});

test("a primed request gives up once the open budget is spent", async () => {
  const t = await setup({ env: { STREAM_OPEN_ATTEMPTS: "1", STREAM_OPEN_BUDGET_MS: "150" } });
  try {
    t.plan = Array(1000).fill("fail");
    const started = Date.now();
    const out = await pull(t).done;
    assert.equal(out.aborted, true);
    assert.ok(Date.now() - started >= 150, "retried for the whole budget");
    assert.ok(t.opens > 1);
    assert.deepEqual(t.failures, ["CAM1"]);
  } finally {
    await t.close();
  }
});

test("without a primer the open budget does not apply", async () => {
  const t = await setup({ keyframe: false, env: { STREAM_OPEN_ATTEMPTS: "2", STREAM_OPEN_BUDGET_MS: "60000" } });
  try {
    t.plan = ["fail", "fail", "feed"];
    const out = await pull(t).done;
    assert.equal(out.status, 502);
    assert.equal(t.opens, 2);
  } finally {
    await t.close();
  }
});

test("STREAM_OPEN_ATTEMPTS=1 fails without retrying", async () => {
  const t = await setup({ keyframe: false, env: { STREAM_OPEN_ATTEMPTS: "1" } });
  try {
    t.plan = ["fail"];
    const out = await pull(t).done;
    assert.equal(out.status, 502);
    assert.equal(t.opens, 1);
  } finally {
    await t.close();
  }
});

test("the live still tap keeps the raw keyframe for the next instant start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instant-start-tap-"));
  try {
    const tap = createLiveStillTap({ sn: "CAM1", dir, toJpeg: async () => Buffer.from("jpeg"), firstAfterMs: 0 });
    tap.onChunk(KEYFRAME);
    await tap.idle();
    const primer = await loadPrimer(dir, "CAM1");
    assert.equal(primer.codec, "h264");
    assert.ok(primer.au.equals(KEYFRAME));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPrimer ignores a missing file, a missing dir and bytes that are not a keyframe", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instant-start-load-"));
  try {
    assert.equal(await loadPrimer(undefined, "CAM1"), null);
    assert.equal(await loadPrimer(dir, "CAM1"), null);
    fs.writeFileSync(lastLiveKeyframeFile(dir, "CAM1"), Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0, 0]));
    assert.equal(await loadPrimer(dir, "CAM1"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stream clients log the P2P transport under BRIDGE_DEBUG_P2P", () => {
  const off = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" });
  assert.equal(streamClientOptions(off.cfg).logger, undefined);
  const on = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", BRIDGE_DEBUG_P2P: "1" });
  assert.ok(streamClientOptions(on.cfg).logger, "a logger is attached");
});

test("a feed that dies before its first bytes is retried, and the primer keeps the consumer fed meanwhile", async () => {
  // A reused session whose camera went back to sleep: openReadable returns, the start command goes
  // unanswered, then the feed fails. The request must not die with it while a retry can still work.
  const t = await setup();
  try {
    const p = pull(t);
    await until(() => t.feeds.length === 1, "first feed opened");
    const before = leadingKeyframes(p.bytes());
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(leadingKeyframes(p.bytes()) > before, "the primer keeps going while the open feed is silent");
    t.feeds[0].destroy(new Error("start unacknowledged"));
    await until(() => t.feeds.length === 2, "retried on a fresh session");
    assert.deepEqual(t.dropped, ["CAM1"], "the failed session was dropped");
    t.feeds[1].end(Buffer.from("live"));
    const out = await p.done;
    assert.equal(out.ended, true);
    assert.equal(out.bytes().subarray(-4).toString(), "live");
    assert.deepEqual(t.failures, []);
  } finally {
    await t.close();
  }
});

test("without a primer, a feed that ends before its first bytes answers 502", async () => {
  const t = await setup({ keyframe: false, env: { STREAM_OPEN_ATTEMPTS: "1" } });
  try {
    const p = pull(t);
    await until(() => t.feeds.length === 1, "feed opened");
    t.feeds[0].end();
    const out = await p.done;
    assert.equal(out.status, 502);
    assert.deepEqual(t.failures, ["CAM1"]);
  } finally {
    await t.close();
  }
});

test("the primer repeats fast at first, so ffmpeg's probe ends well inside the 5 s DESCRIBE deadline", async () => {
  const { startPrimer } = await import("../src/stream-primer.mjs");
  const writes = [];
  const res = { destroyed: false, writableEnded: false, write: (b) => void writes.push(Date.now()) };
  const stop = startPrimer(res, KEYFRAME, { intervalMs: 200, fastMs: 10, fastForMs: 100 });
  await new Promise((r) => setTimeout(r, 100));
  const fast = writes.length;
  await new Promise((r) => setTimeout(r, 300));
  stop();
  const slow = writes.length - fast;
  assert.ok(fast >= 5, `fast phase wrote ${fast}`);
  assert.ok(slow <= 3, `slow phase wrote ${slow}`);
});

// A minimal H.265 keyframe access unit: VPS, SPS, IDR slice.
const HEVC_KEYFRAME = Buffer.from([
  0, 0, 0, 1, 0x40, 0x01, 0x0c, 0, 0, 0, 1, 0x42, 0x01, 0x01, 0, 0, 0, 1, 0x26, 0x01, 0xaf,
]);

test("a camera never watched here starts with the stand-in picture", async () => {
  // Without it, the first live view of a camera times out in the consumer's 5 s DESCRIBE wait.
  const t = await setup({ keyframe: false, env: { STREAM_PLACEHOLDER: "1" } });
  try {
    let release;
    t.gate = new Promise((r) => (release = r));
    const p = pull(t);
    await until(
      () => p.bytes().length >= 2 * PLACEHOLDER_KEYFRAME.length,
      "the stand-in repeated while the camera wakes",
    );
    assert.ok(p.bytes().subarray(0, PLACEHOLDER_KEYFRAME.length).equals(PLACEHOLDER_KEYFRAME));
    release();
    await until(() => t.feeds.length === 1, "live feed opened");
    t.feeds[0].end(Buffer.from("live"));
    const out = await p.done;
    assert.equal(out.ended, true);
    assert.equal(out.bytes().subarray(-4).toString(), "live");
    assert.ok(
      t.log.some((l) => l.includes("stand-in picture")),
      "logged",
    );
  } finally {
    await t.close();
  }
});

test("a kept keyframe wins over the stand-in", async () => {
  const t = await setup({ env: { STREAM_PLACEHOLDER: "1" } });
  try {
    const p = pull(t);
    await until(() => leadingKeyframes(p.bytes()) >= 1, "the kept keyframe first");
    await until(() => t.feeds.length === 1, "live feed opened");
    t.feeds[0].end(Buffer.from("live"));
    await p.done;
  } finally {
    await t.close();
  }
});

test("an H.265 camera behind the H.264 stand-in keeps its keyframe and makes the consumer reconnect", async () => {
  // The consumer's ffmpeg fixed its codec on the stand-in, so H.265 cannot follow in the same response.
  const t = await setup({ keyframe: false, env: { STREAM_PLACEHOLDER: "1" } });
  try {
    const p = pull(t);
    await until(() => t.feeds.length === 1, "live feed opened");
    t.feeds[0].write(HEVC_KEYFRAME);
    const out = await p.done;
    assert.equal(out.aborted, true, "the response is cut so go2rtc reconnects");
    assert.ok(t.feeds[0].destroyed, "this request leaves the shared source");
    const primer = await loadPrimer(t.dir, "CAM1");
    assert.equal(primer?.codec, "hevc", "the reconnect will be primed with H.265");
    assert.deepEqual(t.failures, [], "not a failure");
  } finally {
    await t.close();
  }
});

test("STREAM_PLACEHOLDER=0 keeps the old start for a camera never watched", async () => {
  const t = await setup({ keyframe: false, env: { STREAM_PLACEHOLDER: "0", STREAM_OPEN_ATTEMPTS: "1" } });
  try {
    t.plan = ["error"];
    const out = await pull(t).done;
    assert.equal(out.status, 502);
  } finally {
    await t.close();
  }
});

test("an error other than an unreachable camera is still reported as a failed attempt, and paused after", async () => {
  const t = await setup({
    env: { STREAM_OPEN_ATTEMPTS: "1", STREAM_OPEN_BUDGET_MS: "60000", STREAM_OPEN_RETRY_PAUSE_MS: "80" },
  });
  try {
    t.plan = ["error", "error", "feed"];
    const started = Date.now();
    const p = pull(t);
    await until(() => t.feeds.length === 1, "third attempt opened the feed");
    assert.ok(Date.now() - started >= 160, "a failure that came back at once waits out the pause");
    t.feeds[0].end(Buffer.from("live"));
    await p.done;
    assert.ok(
      t.log.some((l) => l.includes("open attempt 1, primed failed (cloud said no)")),
      "logged",
    );
  } finally {
    await t.close();
  }
});

test("a session that took its time to fail is not followed by an extra pause", async () => {
  const t = await setup({
    env: { STREAM_OPEN_ATTEMPTS: "1", STREAM_OPEN_BUDGET_MS: "60000", STREAM_OPEN_RETRY_PAUSE_MS: "50" },
  });
  try {
    t.plan = ["fail", "feed"];
    t.gate = new Promise((r) => setTimeout(r, 120)); // each open takes 120 ms, longer than the pause
    const started = Date.now();
    const p = pull(t);
    await until(() => t.feeds.length === 1, "second attempt opened the feed");
    assert.ok(Date.now() - started < 120 + 120 + 50, "no pause on top of the slow failure");
    t.feeds[0].end(Buffer.from("live"));
    await p.done;
  } finally {
    await t.close();
  }
});
