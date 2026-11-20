import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { writeGo2rtcConfig } from "../go2rtc-config.mjs";
import { createGo2rtcRegistry } from "../src/go2rtc-registry.mjs";
import { createBoot } from "../src/boot.mjs";
import { createState } from "../src/state.mjs";

const camera = (sn) => ({ sn, stream: `/stream/${sn}` });
const optics = (sn) => ({
  ...camera(sn),
  model: "T8410",
  views: [0, 1].map((view) => ({
    id: view === 0 ? sn : `${sn}_view_${view}`,
    stream: `/stream/${sn}${view === 0 ? "" : `?view=${view}`}`,
  })),
});

async function fixture(t, initial = [camera("KNOWN")]) {
  const dir = await mkdtemp(join(tmpdir(), "go2rtc-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = {
    go2rtcConfig: join(dir, "go2rtc.yaml"),
    selfHost: "127.0.0.1",
    port: 3300,
    go2rtcApiPort: 11984,
    go2rtcEnable: true,
  };
  await writeGo2rtcConfig(cfg, initial);
  const ctx = { cfg, state: createState(), deviceList: async () => initial };
  ctx.state.flags.ready = true;
  ctx.state.flags.go2rtcProc = {};
  const saved = async () => parse(await readFile(cfg.go2rtcConfig, "utf8"));
  const live = Object.fromEntries(Object.keys((await saved()).streams).map((name) => [name, { consumers: [] }]));
  const calls = [];
  const f = { ctx, live, calls, saved, failGet: 0, failPut: undefined, failDelete: 0, invalidList: false };
  const request = async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, "http://127.0.0.1:11984");
    assert.equal(url.pathname, "/api/streams");
    assert.ok(options.signal instanceof AbortSignal);
    const name = url.searchParams.get("name");
    const sources = url.searchParams.getAll("src");
    calls.push({ method: options.method, name, sources });
    if (options.method === "GET") {
      if (f.failGet-- > 0) return { ok: false, status: 503 };
      return { ok: true, json: async () => (f.invalidList ? [] : { ...live }) };
    }
    if (options.method === "PUT" && name === f.failPut) {
      f.failPut = undefined;
      return { ok: false, status: 503 };
    }
    if (options.method === "PUT" && sources.some((source) => /\s/.test(source))) return { ok: false, status: 400 };
    if (options.method === "DELETE" && f.failDelete-- > 0) return { ok: false, status: 503 };
    // Model go2rtc's API contract: PUT/DELETE also patch the same YAML file.
    const config = await saved();
    if (options.method === "PUT") {
      assert.ok(sources.length);
      assert.equal(Object.hasOwn(live, name), false, "an existing source must never be replaced");
      live[name] = { consumers: [] };
      config.streams[name] = sources;
    } else {
      assert.equal(options.method, "DELETE");
      assert.equal(sources.length, 1);
      delete live[sources[0]];
      delete config.streams[sources[0]];
    }
    await writeFile(cfg.go2rtcConfig, stringify(config, { lineWidth: 0 }));
    return { ok: true };
  };
  return Object.assign(f, createGo2rtcRegistry(ctx, request));
}

test("late cameras retain audio, optical paths, input hints and the configured API port", async (t) => {
  const f = await fixture(t);
  const watched = f.live.KNOWN;
  watched.consumers.push({ id: "viewer" });
  f.ctx.deviceList = async () => [optics("LATE")];
  await f.syncGo2rtcRegistry();
  await f.syncGo2rtcRegistry();

  const added = f.calls.filter((call) => call.method === "PUT");
  assert.deepEqual(
    added.map((call) => call.name),
    ["LATE", "LATE_view_1"],
  );
  assert.deepEqual(added[1].sources, [
    "ffmpeg:http://127.0.0.1:3300/stream/LATE?view=1#video=copy#async#input=eufy_h264",
    "http://127.0.0.1:3300/audio/LATE?view=1",
    "ffmpeg:LATE_view_1#audio=opus#raw=eufy_audio_timestamps",
  ]);
  assert.strictEqual(f.live.KNOWN, watched);
  assert.deepEqual(watched.consumers, [{ id: "viewer" }]);
  assert.deepEqual((await f.saved()).streams.LATE_view_1, added[1].sources);
  assert.ok(f.calls.every((call) => ["GET", "PUT"].includes(call.method)));
});

test("empty discovery retains cached cameras and leaves existing viewers untouched", async (t) => {
  const f = await fixture(t);
  const before = (await f.saved()).streams;
  f.ctx.deviceList = async () => [];
  await f.syncGo2rtcRegistry();
  assert.deepEqual((await f.saved()).streams, before);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["GET"],
  );
});

test("a saved legacy scalar source can be restored to go2rtc", async (t) => {
  const f = await fixture(t);
  const config = await f.saved();
  config.streams.KNOWN = "ffmpeg:http://127.0.0.1:3300/stream/KNOWN#video=copy";
  await writeFile(f.ctx.cfg.go2rtcConfig, stringify(config));
  delete f.live.KNOWN;
  f.ctx.deviceList = async () => [];
  await f.syncGo2rtcRegistry();
  assert.deepEqual(f.calls.find((call) => call.method === "PUT").sources, [config.streams.KNOWN]);
});

test("cached inline audio filters migrate to the same named filter before dynamic registration", async (t) => {
  const f = await fixture(t);
  const config = await f.saved();
  config.streams.KNOWN[2] = "ffmpeg:KNOWN#audio=opus#raw=-af asetpts=N/SR/TB";
  await writeFile(f.ctx.cfg.go2rtcConfig, stringify(config));
  delete f.live.KNOWN;
  f.ctx.deviceList = async () => [];
  await f.syncGo2rtcRegistry();
  const added = f.calls.find((call) => call.method === "PUT");
  assert.equal(added.sources[2], "ffmpeg:KNOWN#audio=opus#raw=eufy_audio_timestamps");
  assert.equal((await f.saved()).ffmpeg.eufy_audio_timestamps, "-af asetpts=N/SR/TB");
});

for (const condition of ["stopped", "disabled", "recovering", "sessionLost"]) {
  test(`registry does no discovery or HTTP while ${condition}`, async (t) => {
    const f = await fixture(t);
    if (condition === "stopped") f.ctx.state.flags.go2rtcProc = undefined;
    else if (condition === "disabled") f.ctx.cfg.go2rtcEnable = false;
    else f.ctx.state.flags[condition] = true;
    f.ctx.deviceList = () => assert.fail("discovery must not run");
    await f.syncGo2rtcRegistry();
    assert.deepEqual(f.calls, []);
  });
}

test("list failures are retryable without losing saved cameras", async (t) => {
  const f = await fixture(t);
  f.ctx.deviceList = async () => [camera("LATE")];
  f.failGet = 1;
  await assert.rejects(f.syncGo2rtcRegistry(), /GET: HTTP 503/);
  assert.deepEqual(Object.keys((await f.saved()).streams), ["KNOWN"]);
  await f.syncGo2rtcRegistry();
  assert.ok(f.live.LATE);
});

test("a failed registration retries only the missing source", async (t) => {
  const f = await fixture(t);
  f.ctx.deviceList = async () => [camera("FIRST"), camera("SECOND")];
  f.failPut = "SECOND";
  await assert.rejects(f.syncGo2rtcRegistry(), /PUT: HTTP 503/);
  await f.syncGo2rtcRegistry();
  assert.deepEqual(
    f.calls.filter((call) => call.method === "PUT").map((call) => call.name),
    ["FIRST", "SECOND", "SECOND"],
  );
});

test("overlapping sweeps share one discovery and registration", async (t) => {
  const f = await fixture(t);
  let release;
  let discoveries = 0;
  f.ctx.deviceList = () => {
    discoveries++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const first = f.syncGo2rtcRegistry();
  const second = f.syncGo2rtcRegistry();
  assert.strictEqual(first, second);
  await nextTurn();
  release([camera("LATE")]);
  await Promise.all([first, second]);
  assert.equal(discoveries, 1);
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 1);
});

test("malformed runtime metadata cannot cause writes", async (t) => {
  const f = await fixture(t);
  f.invalidList = true;
  f.ctx.deviceList = async () => [camera("LATE")];
  await assert.rejects(f.syncGo2rtcRegistry(), /Invalid go2rtc/);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["GET"],
  );
});

test("only explicit removal forgets a camera and its numbered views", async (t) => {
  const f = await fixture(t, [optics("REMOVED"), camera("OTHER"), camera("REMOVED_view_backup")]);
  await f.forgetGo2rtcDevice("REMOVED");
  assert.deepEqual(Object.keys(f.live), ["OTHER", "REMOVED_view_backup"]);
  assert.deepEqual(Object.keys((await f.saved()).streams), ["OTHER", "REMOVED_view_backup"]);
  await f.syncGo2rtcRegistry(); // stale discovery still contains the removed camera
  assert.equal(Object.hasOwn(f.live, "REMOVED"), false);

  await f.rememberGo2rtcDevice("REMOVED");
  assert.ok(f.live.REMOVED);
  assert.ok(f.live.REMOVED_view_1);
});

test("explicit removal is persisted even while go2rtc is stopped", async (t) => {
  const f = await fixture(t);
  f.ctx.state.flags.go2rtcProc = undefined;
  await f.forgetGo2rtcDevice("KNOWN");
  assert.deepEqual((await f.saved()).streams, {});
  assert.deepEqual(f.calls, []);
});

test("a failed runtime removal is retried after the saved entry has been removed", async (t) => {
  const f = await fixture(t);
  f.failDelete = 1;
  await assert.rejects(f.forgetGo2rtcDevice("KNOWN"), /DELETE: HTTP 503/);
  assert.deepEqual((await f.saved()).streams, {});
  await f.syncGo2rtcRegistry();
  assert.deepEqual(Object.keys(f.live), []);
});

test("removal during discovery cannot be undone by the outstanding sweep", async (t) => {
  const f = await fixture(t);
  let release;
  f.ctx.deviceList = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const syncing = f.syncGo2rtcRegistry();
  await nextTurn();
  const forgetting = f.forgetGo2rtcDevice("KNOWN");
  f.ctx.deviceList = async () => [camera("KNOWN")];
  release([camera("KNOWN")]);
  await Promise.all([syncing, forgetting]);
  assert.deepEqual(Object.keys(f.live), []);
  assert.deepEqual((await f.saved()).streams, {});
  assert.ok(!f.calls.some((call) => call.method === "PUT"));
});

test("a re-added device supersedes a queued removal", async (t) => {
  const f = await fixture(t);
  const forgetting = f.forgetGo2rtcDevice("KNOWN");
  const remembering = f.rememberGo2rtcDevice("KNOWN");
  await Promise.all([forgetting, remembering]);
  assert.ok(f.live.KNOWN);
  assert.ok((await f.saved()).streams.KNOWN);
  assert.ok(!f.calls.some((call) => call.method === "DELETE"));
});

test("an existing runtime source missing from YAML is persisted without replacement", async (t) => {
  const f = await fixture(t);
  const config = await f.saved();
  delete config.streams.KNOWN;
  await writeFile(f.ctx.cfg.go2rtcConfig, stringify(config));
  await f.syncGo2rtcRegistry();
  assert.ok((await f.saved()).streams.KNOWN);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["GET"],
  );
});

test("boot wires SDK roster events and one periodic reconciliation without starting real media", async (t) => {
  const f = await fixture(t, []);
  f.ctx.state.flags.ready = false;
  f.ctx.state.flags.go2rtcProc = undefined;
  f.ctx.eufy = Object.assign(new EventEmitter(), { getDevices: async () => [] });
  Object.assign(f.ctx, {
    FORWARDED_EVENTS: [],
    DETECTION_EVENTS: new Set(),
    warmFaceRoster: async () => {},
    warmLastEventImages: async () => {},
    watchdogTick: async () => {},
    broadcast() {},
    syncGo2rtcRegistry: t.mock.fn(async () => {}),
    rememberGo2rtcDevice: t.mock.fn(async () => {}),
    forgetGo2rtcDevice: t.mock.fn(async () => {}),
  });
  const process = Object.assign(new EventEmitter(), { kill() {} });
  const spawn = t.mock.fn(() => process);
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(console, "log", () => {});
  const boot = createBoot(f.ctx, spawn);
  await boot.completeBoot();
  await boot.completeBoot();
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(f.ctx.eufy.listenerCount("deviceAdded"), 1);
  assert.equal(f.ctx.eufy.listenerCount("deviceRemoved"), 1);
  f.ctx.eufy.emit("deviceAdded", { sn: "LATE" });
  f.ctx.eufy.emit("deviceRemoved", { sn: "GONE" });
  assert.deepEqual(f.ctx.rememberGo2rtcDevice.mock.calls[0].arguments, ["LATE"]);
  assert.deepEqual(f.ctx.forgetGo2rtcDevice.mock.calls[0].arguments, ["GONE"]);
  t.mock.timers.tick(30_000);
  assert.equal(f.ctx.syncGo2rtcRegistry.mock.callCount(), 1);
});
