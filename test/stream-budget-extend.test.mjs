// A watched battery stream is kept going past the SDK's budget. The SDK stops a battery stream ~55 s in
// (45 s budget + 10 s grace) unless the caller extends it; openReadable() dropped that notice, so the viewer
// froze, the "streaming" sensor went off, and only reopening the view brought the picture back. /stream now
// opens a battery camera's feed through live() and extends the budget while go2rtc still lists a consumer,
// up to STREAM_BATTERY_MAX_MS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { liveFeedOpener, readableFromLive } from "../src/live-feed.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0"; // no real HTTP at :1984 from the consumer probe
const { createHttpHandler } = await import("../src/http-routes.mjs");

/** The SDK's live() consumer, as far as the bridge uses it. */
class FakeConsumer extends EventEmitter {
  paused = false;
  stopped = false;
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  stop() {
    this.stopped = true;
  }
}

async function until(cond, what) {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** A bridge HTTP server over one fake battery camera whose live() hands out FakeConsumers. */
async function setup({ env = {}, viewers = 1, describe, openReadable } = {}) {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", STREAM_PLACEHOLDER: "0", ...env });
  const state = createState();
  state.flags.ready = true;
  const t = { consumers: [], opened: [], log: [], viewers };
  const ctx = {
    ...config,
    state,
    eventImageDir: undefined, // no primer: the stream starts once the first frame is in
    eventLog: (line) => void t.log.push(line),
    broadcast: () => {},
    noteStreamOpened: () => {},
    noteStreamFailure: () => {},
    streamBackoffMs: () => 0,
    go2rtcConsumerCount: viewers === null ? undefined : async () => t.viewers, // null: ask the real API
    streamClientFor: async () => ({
      getDevice: async () => ({
        describe,
        camera: () => ({
          openReadable,
          live: async (opts) => {
            t.opened.push(opts);
            const c = new FakeConsumer();
            t.consumers.push(c);
            setImmediate(() => c.emit("video", { data: Buffer.from("frame") }));
            return c;
          },
        }),
      }),
    }),
  };
  const server = http.createServer((req, res) => void createHttpHandler(ctx)(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.pull = () => {
    const out = { bytes: 0 };
    out.req = http.get({ host: "127.0.0.1", port, path: "/stream/CAM1" }, (res) => {
      out.status = res.statusCode;
      res.on("data", (c) => (out.bytes += c.length));
    });
    out.req.on("error", () => {});
    return out;
  };
  t.close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  };
  return t;
}

/** Fire a budget notice on the camera's consumer; resolves with the extend() calls it got. */
async function budget(t) {
  const extended = [];
  t.consumers[0].emit("budget", { graceMs: 10_000, extend: (ms) => extended.push(ms ?? "default") });
  await new Promise((r) => setTimeout(r, 30)); // the decision asks go2rtc first
  return extended;
}

test("a watched stream's budget is extended, by the configured budget", async () => {
  const t = await setup({ env: { STREAM_BATTERY_BUDGET_MS: "120000" } });
  try {
    const p = t.pull();
    await until(() => p.bytes > 0, "live bytes");
    assert.equal(t.opened[0].batteryBudgetMs, 120000, "the budget still goes to the session");
    assert.deepEqual(await budget(t), [120000]);
    assert.ok(
      t.log.some((l) => l.includes("battery budget extended (1 viewer(s)")),
      "logged",
    );
  } finally {
    await t.close();
  }
});

test("without a configured budget the extension is another SDK default budget", async () => {
  const t = await setup();
  try {
    const p = t.pull();
    await until(() => p.bytes > 0, "live bytes");
    assert.deepEqual(await budget(t), ["default"]);
  } finally {
    await t.close();
  }
});

test("a stream go2rtc lists no viewer for is left to stop", async () => {
  const t = await setup({ viewers: 0 });
  try {
    const p = t.pull();
    await until(() => p.bytes > 0, "live bytes");
    assert.deepEqual(await budget(t), []);
    assert.ok(t.log.some((l) => l.includes("not extended: go2rtc lists no viewer")));
  } finally {
    await t.close();
  }
});

test("when go2rtc cannot be asked, the stream is extended (the cap still applies)", async () => {
  const t = await setup({ viewers: null });
  try {
    const p = t.pull();
    await until(() => p.bytes > 0, "live bytes");
    assert.deepEqual(await budget(t), ["default"]);
    assert.ok(t.log.some((l) => l.includes("viewer unknown")));
  } finally {
    await t.close();
  }
});

test("STREAM_BATTERY_MAX_MS caps how long a watched battery stream is kept going", async () => {
  const t = await setup({ env: { STREAM_BATTERY_MAX_MS: "50" } });
  try {
    const p = t.pull();
    await until(() => p.bytes > 0, "live bytes");
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(await budget(t), []);
    assert.ok(t.log.some((l) => l.includes("not extended: streaming for") && l.includes("STREAM_BATTERY_MAX_MS")));
  } finally {
    await t.close();
  }
});

test("STREAM_BATTERY_MAX_MS=0 removes the cap", async () => {
  const { cfg } = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", STREAM_BATTERY_MAX_MS: "0" });
  assert.equal(cfg.streamBatteryMaxMs, 0);
  const t = await setup({ env: { STREAM_BATTERY_MAX_MS: "0" } });
  try {
    const p = t.pull();
    await until(() => p.bytes > 0, "live bytes");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await budget(t), ["default"]);
  } finally {
    await t.close();
  }
});

test("a viewer that left is not extended for", async () => {
  const t = await setup();
  try {
    const p = t.pull();
    await until(() => p.bytes > 0, "live bytes");
    p.req.destroy();
    await until(() => t.consumers[0].stopped, "the consumer detached when the viewer left");
    assert.deepEqual(await budget(t), []);
  } finally {
    await t.close();
  }
});

test("the viewer count is asked of go2rtc on its configured API port", async () => {
  const go2rtc = http.createServer((req, res) => res.end(JSON.stringify({ consumers: [] })));
  await new Promise((r) => go2rtc.listen(0, "127.0.0.1", r));
  const t = await setup({ env: { GO2RTC_API_PORT: String(go2rtc.address().port) }, viewers: null });
  try {
    const p = t.pull();
    await until(() => p.bytes > 0, "live bytes");
    assert.deepEqual(await budget(t), []);
    await until(() => t.log.some((l) => l.includes("go2rtc lists no viewer")), "the reason logged");
    p.req.destroy();
  } finally {
    await t.close();
    go2rtc.closeAllConnections();
    await new Promise((r) => go2rtc.close(r));
  }
});

test("readableFromLive: frames become bytes, backpressure pauses the consumer, destroy detaches it", () => {
  const c = new FakeConsumer();
  const feed = readableFromLive(c);
  feed.pause();
  for (let i = 0; i < 2000 && !c.paused; i++) c.emit("video", { data: Buffer.alloc(1024) });
  assert.ok(c.paused, "a full buffer pauses the consumer");
  const first = feed.read(1024);
  assert.equal(first.length, 1024);
  feed.destroy();
  assert.ok(c.stopped, "destroying the feed detaches the consumer");
});

test("readableFromLive: the consumer's stop ends the feed and its error fails it", async () => {
  const ended = new FakeConsumer();
  const a = readableFromLive(ended);
  const end = new Promise((r) => a.on("end", r));
  a.resume();
  ended.emit("stop");
  await end;

  const failing = new FakeConsumer();
  const b = readableFromLive(failing);
  const err = new Promise((r) => b.on("error", r));
  failing.emit("error", new Error("warm-up timeout"));
  assert.equal((await err).message, "warm-up timeout");
});

test("liveFeedOpener falls back to openReadable on a camera without live()", async () => {
  const marker = {};
  const open = liveFeedOpener({ openReadable: async (o) => ({ marker, o }) }, { onBudget: () => {} });
  const feed = await open({ batteryBudgetMs: 1 });
  assert.equal(feed.marker, marker);
  assert.deepEqual(feed.o, { batteryBudgetMs: 1 });
});

test("liveFeedOpener hands a caller that asks for the budget the notice, through live()", async () => {
  const c = new FakeConsumer();
  const notices = [];
  const open = liveFeedOpener(
    { live: async () => c, openReadable: async () => assert.fail("openReadable drops the budget notice") },
    { onBudget: (notice) => notices.push(notice) },
  );
  await open();
  c.emit("budget", { graceMs: 10_000 });
  assert.deepEqual(notices, [{ graceMs: 10_000 }]);
});

test("a battery camera goes through live() even where the SDK offers openReadable", async () => {
  const t = await setup({ openReadable: async () => assert.fail("openReadable drops the budget notice") });
  try {
    const p = t.pull();
    await until(() => p.bytes > 0, "live bytes");
    assert.deepEqual(await budget(t), ["default"]);
    p.req.destroy();
  } finally {
    await t.close();
  }
});

test("a mains camera stays on openReadable: it has no budget to extend", async () => {
  const feed = new PassThrough();
  const t = await setup({
    describe: () => ({ model: "T8530", capabilities: ["camera"] }),
    openReadable: async () => feed,
  });
  try {
    const p = t.pull();
    feed.write("frame");
    await until(() => p.bytes > 0, "the first bytes");
    assert.equal(t.opened.length, 0);
    p.req.destroy();
  } finally {
    await t.close();
  }
});
