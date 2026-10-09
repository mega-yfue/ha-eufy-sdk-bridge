// /stream request lifecycle, driven over a real loopback HTTP connection.
//
// - A feed that fails (P2P drop, warm-up timeout) must take the HTTP response down with it. pipe() only
//   ends the response on a clean end, so without that ffmpeg sits on an open, silent socket until its own
//   timeout and go2rtc reconnects late.
// - A viewer that leaves while the session is still opening must not leave a feed behind that nobody
//   reads: it would hold the camera's live source open and report the camera as streaming.
// - Requests for one camera overlap briefly when ffmpeg reconnects before the old connection has closed.
//   Each must release only its own registration, or the camera reads as idle while it streams.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createStreamIdle } from "../src/stream-idle.mjs";

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

/**
 * A bridge HTTP server over a fake camera. `openReadable` hands out the feeds the test pushes into
 * `feeds`; `gate` (if set) holds an open until the test releases it.
 */
async function setup() {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" });
  const state = createState();
  state.flags.ready = true;
  const t = { state, broadcasts: [], feeds: [], opens: 0, dropped: [], failures: [], gate: null };
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
    // `t.lease` (if set) is handed to every request, like two requests sharing one cached login.
    streamClientFor: (sn) => t.lease ?? makeClient(sn),
  };
  async function makeClient() {
    if (t.clientGate) await t.clientGate;
    return {
      getDevice: async () => ({
        // `t.describe` (if set) is the device's manifest; absent, the camera's power source is unknown.
        ...(t.describe ? { describe: () => t.describe } : {}),
        camera: () => ({
          openReadable: async () => {
            t.opens++;
            if (t.gate) await t.gate;
            if (t.openError) throw t.openError;
            const feed = new PassThrough();
            t.feeds.push(feed);
            return feed;
          },
        }),
      }),
    };
  }
  t.makeClient = makeClient;
  t.ctx = ctx;
  const handler = createHttpHandler(ctx);
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.port = server.address().port;
  t.close = () => {
    server.closeAllConnections(); // a response the handler left open must not hold the test run
    return new Promise((r) => server.close(r));
  };
  return t;
}

/** Open /stream/CAM1 and collect what arrives; `done` settles with how the response ended. */
function pull(t) {
  const out = { bytes: 0, ended: false, aborted: false };
  out.req = http.get({ host: "127.0.0.1", port: t.port, path: "/stream/CAM1" });
  out.done = new Promise((resolve) => {
    out.req.on("response", (res) => {
      out.status = res.statusCode;
      res.on("data", (c) => (out.bytes += c.length));
      res.on("end", () => {
        out.ended = true;
        resolve(out);
      });
      res.on("aborted", () => {
        out.aborted = true;
        resolve(out);
      });
      res.on("error", () => {
        out.aborted = true;
        resolve(out);
      });
    });
    out.req.on("error", () => {
      out.aborted = true;
      resolve(out);
    });
  });
  return out;
}

/** How the response ended, or `timedOut` if it is still open after `ms` — the defect, not a hang. */
async function settled(p, ms = 1000) {
  const timeout = new Promise((r) => setTimeout(() => r({ ...p, timedOut: true }), ms));
  return Promise.race([p.done, timeout]);
}

const inactive = (t) => t.broadcasts.filter((b) => b.event === "streamState" && b.active === false);

test("a clean end of the feed ends the response with every byte (control case)", async () => {
  const t = await setup();
  try {
    const p = pull(t);
    await until(() => t.feeds.length === 1, "feed opened");
    t.feeds[0].write(Buffer.alloc(1000));
    t.feeds[0].end(Buffer.alloc(500));
    const out = await settled(p);
    assert.equal(out.status, 200);
    assert.equal(out.ended, true);
    assert.equal(out.bytes, 1500);
    await until(() => !t.state.streaming.has("CAM1"), "streaming cleared");
    assert.equal(t.state.activeStreams.has("CAM1"), false);
  } finally {
    await t.close();
  }
});

test("a feed that fails mid-stream aborts the response instead of leaving it open", async () => {
  const t = await setup();
  try {
    const p = pull(t);
    await until(() => t.feeds.length === 1, "feed opened");
    t.feeds[0].write(Buffer.alloc(1000));
    await until(() => p.bytes === 1000, "first bytes delivered");
    t.feeds[0].destroy(new Error("P2P session lost"));
    const out = await settled(p);
    assert.notEqual(out.timedOut, true, "response left open on a silent socket");
    assert.equal(out.aborted, true, "the client must see the response die");
    assert.equal(out.ended, false);
    await until(() => !t.state.streaming.has("CAM1"), "streaming cleared");
    assert.equal(t.state.activeStreams.has("CAM1"), false);
    assert.equal(inactive(t).length, 1);
  } finally {
    await t.close();
  }
});

test("a feed that closes before its end aborts the response too", async () => {
  const t = await setup();
  try {
    const p = pull(t);
    await until(() => t.feeds.length === 1, "feed opened");
    t.feeds[0].write(Buffer.alloc(100));
    await until(() => p.bytes === 100, "first bytes delivered");
    t.feeds[0].destroy(); // no error, no end — e.g. the consumer was detached underneath us
    const out = await settled(p);
    assert.notEqual(out.timedOut, true, "response left open on a silent socket");
    assert.equal(out.aborted, true);
    assert.equal(out.ended, false);
  } finally {
    await t.close();
  }
});

test("a viewer that leaves while the feed is opening leaves no feed behind", async () => {
  const t = await setup();
  try {
    let release;
    t.gate = new Promise((r) => (release = r));
    const p = pull(t);
    await until(() => t.opens === 1, "open in progress");
    p.req.destroy(); // ffmpeg gives up while the P2P session is still connecting
    await settled(p);
    await new Promise((r) => setTimeout(r, 30)); // let the server see the disconnect
    release();
    await until(() => t.feeds.length === 1, "late feed handed out");
    await until(() => t.feeds[0].destroyed, "late feed released");
    assert.equal(t.state.streaming.has("CAM1"), false, "nobody is watching");
    assert.equal(t.state.activeStreams.has("CAM1"), false);
    assert.equal(t.broadcasts.filter((b) => b.active === true).length, 0, "never announced as streaming");
  } finally {
    await t.close();
  }
});

test("a viewer that leaves before the session is up does not wake the camera at all", async () => {
  const t = await setup();
  try {
    let release;
    t.clientGate = new Promise((r) => (release = r));
    const p = pull(t);
    await new Promise((r) => setTimeout(r, 30));
    p.req.destroy();
    await settled(p);
    await new Promise((r) => setTimeout(r, 30));
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(t.opens, 0, "no live session opened for a viewer that is already gone");
    assert.equal(t.state.streaming.has("CAM1"), false);
  } finally {
    await t.close();
  }
});

test("a failed open after the viewer left still drops the client and arms the backoff", async () => {
  const t = await setup();
  try {
    let release;
    t.gate = new Promise((r) => (release = r));
    t.openError = new Error("P2P connect timeout");
    const p = pull(t);
    await until(() => t.opens === 1, "open in progress");
    p.req.destroy();
    await settled(p);
    await new Promise((r) => setTimeout(r, 30));
    release();
    await until(() => t.dropped.length === 1, "client dropped");
    assert.deepEqual(t.dropped, ["CAM1"], "a session that just failed must not be reused");
    assert.deepEqual(t.failures, ["CAM1"], "the next retry must not wake the radio again");
  } finally {
    await t.close();
  }
});

test("overlapping requests: the older one closing does not unregister the newer one", async () => {
  const t = await setup();
  try {
    const a = pull(t);
    await until(() => t.feeds.length === 1, "A opened");
    const b = pull(t); // ffmpeg reconnects before A's connection has gone
    await until(() => t.feeds.length === 2, "B opened");
    a.req.destroy();
    await settled(a);
    await until(() => t.feeds[0].destroyed, "A released");
    assert.equal(t.state.streaming.has("CAM1"), true, "B is still streaming");
    assert.equal(t.state.activeStreams.get("CAM1")?.feed, t.feeds[1]);
    assert.equal(inactive(t).length, 0, "no 'stopped' while B streams");

    b.req.destroy();
    await settled(b);
    await until(() => !t.state.streaming.has("CAM1"), "streaming cleared after the last one");
    assert.equal(t.state.activeStreams.has("CAM1"), false);
    assert.equal(inactive(t).length, 1, "'stopped' announced exactly once");
  } finally {
    await t.close();
  }
});

test("overlapping requests: the newer one closing first keeps the older one registered", async () => {
  const t = await setup();
  try {
    const a = pull(t);
    await until(() => t.feeds.length === 1, "A opened");
    const b = pull(t);
    await until(() => t.feeds.length === 2, "B opened");
    b.req.destroy();
    await settled(b);
    await until(() => t.feeds[1].destroyed, "B released");
    assert.equal(t.state.streaming.has("CAM1"), true, "A is still streaming");
    assert.equal(t.state.activeStreams.get("CAM1")?.feed, t.feeds[0], "the idle sweep must still see A");
    assert.equal(inactive(t).length, 0);

    a.req.destroy();
    await settled(a);
    await until(() => !t.state.streaming.has("CAM1"), "streaming cleared");
    assert.equal(inactive(t).length, 1);
  } finally {
    await t.close();
  }
});

test("the idle sweep closes every open request for the camera, not only the one it sees", async () => {
  const t = await setup();
  try {
    const a = pull(t);
    await until(() => t.feeds.length === 1, "A opened");
    const b = pull(t); // ffmpeg reconnected before A's connection went
    await until(() => t.feeds.length === 2, "B opened");
    const idle = createStreamIdle({ cfg: { streamIdleMs: 1 }, state: t.state, SUSPEND_RELEASE_MS: 60_000 });
    await new Promise((r) => setTimeout(r, 5)); // both older than the idle window
    idle.streamIdleTick();
    const [ra, rb] = await Promise.all([settled(a), settled(b)]);
    assert.ok(!ra.timedOut && !rb.timedOut, "both responses closed, so go2rtc meets the suspension");
    assert.ok(
      t.feeds.every((f) => f.destroyed),
      "no feed keeps the live source open",
    );
    assert.equal(t.state.idleSuspended.has("CAM1"), true);
    await until(() => !t.state.streaming.has("CAM1"), "streaming cleared");
    assert.equal(t.state.activeStreams.has("CAM1"), false);
    assert.equal(inactive(t).length, 1, "'stopped' announced exactly once");
  } finally {
    await t.close();
  }
});

test("the idle sweep leaves a mains camera streaming (an NVR keeps its feed)", async () => {
  const t = await setup();
  // T8423 floodlight: resolves the `battery` capability but is a mains-only model (ha-eufy-sdk-bridge#101).
  t.describe = { sn: "CAM1", model: "T8423", capabilities: ["camera", "video", "battery"] };
  try {
    const a = pull(t);
    await until(() => t.feeds.length === 1, "A opened");
    const idle = createStreamIdle({ cfg: { streamIdleMs: 1 }, state: t.state, SUSPEND_RELEASE_MS: 60_000 });
    await new Promise((r) => setTimeout(r, 5)); // older than the idle window
    idle.streamIdleTick();
    assert.equal(t.feeds[0].destroyed, false, "the mains feed keeps streaming");
    assert.equal(t.state.idleSuspended.has("CAM1"), false, "and is never suspended");
    assert.equal(t.state.activeStreams.has("CAM1"), true);
    a.req.destroy();
  } finally {
    await t.close();
  }
});

test("the idle sweep still auto-offs a battery camera", async () => {
  const t = await setup();
  t.describe = { sn: "CAM1", model: "T8170", capabilities: ["camera", "video", "battery"] };
  try {
    const a = pull(t);
    await until(() => t.feeds.length === 1, "A opened");
    const idle = createStreamIdle({ cfg: { streamIdleMs: 1 }, state: t.state, SUSPEND_RELEASE_MS: 60_000 });
    await new Promise((r) => setTimeout(r, 5));
    idle.streamIdleTick();
    await settled(a);
    assert.equal(t.feeds[0].destroyed, true);
    assert.equal(t.state.idleSuspended.has("CAM1"), true);
  } finally {
    await t.close();
  }
});

test("requests that waited on one failed login arm the backoff once", async () => {
  const t = await setup();
  try {
    let fail;
    t.lease = new Promise((_, reject) => (fail = reject));
    t.lease.catch(() => {}); // rejected below, awaited by both requests
    const a = pull(t);
    const b = pull(t);
    await new Promise((r) => setTimeout(r, 50)); // both are waiting on the shared login
    fail(new Error("login failed"));
    const [ra, rb] = await Promise.all([settled(a), settled(b)]);
    assert.equal(ra.status, 502);
    assert.equal(rb.status, 502);
    assert.deepEqual(t.failures, ["CAM1"], "one failed login is one failure, not a streak of two");
  } finally {
    await t.close();
  }
});

test("a failed open does not drop the client under a request still streaming on it", async () => {
  const t = await setup();
  try {
    t.lease = t.makeClient(); // both requests share this logged-in client
    const a = pull(t);
    await until(() => t.feeds.length === 1, "A streaming");
    t.openError = new Error("P2P open failed");
    const b = pull(t);
    const rb = await settled(b);
    assert.equal(rb.status, 502);
    assert.deepEqual(t.failures, ["CAM1"]);
    assert.deepEqual(t.dropped, [], "A still streams on that client");
    assert.equal(t.state.streaming.has("CAM1"), true);
    a.req.destroy();
    await settled(a);
    await until(() => t.dropped.length === 1, "dropped once A ended");
    assert.deepEqual(t.dropped, ["CAM1"], "the failed session is not reused after all");
  } finally {
    await t.close();
  }
});
