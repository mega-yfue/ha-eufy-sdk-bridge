// SDK-advertised optical views through the actual WS, HTTP and go2rtc callers. Created with Codex.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createState } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";
import { createDeviceView } from "../src/device-view.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0";
const { createHttpHandler } = await import("../src/http-routes.mjs");
const SN = "T8000P0000000001";
const HUB = "T8000P0000000000";

/** SDK boundary fixture retains product, category, owner name, parent channel and capabilities. */
async function setup(t, { views = [0, 1], legacy = false, model = "T8E00", liveOnly = false, outputs = [] } = {}) {
  const record = {
    sn: SN,
    model,
    name: "Synthetic garden PoE Cam S4",
    category: "eufy_security",
    deviceClass: "other",
    stationSn: HUB,
    channel: 3,
    raw: { parent_sn: HUB, device_channel: 3, device_model: model, device_name: "Synthetic garden PoE Cam S4" },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-optics-"));
  const state = createState();
  state.flags.ready = true;
  const calls = { opens: [], snapshots: [], stored: 0, dropped: 0, failures: 0 };
  const camera = {
    ...(outputs.length ? { outputResolutions: () => outputs } : {}),
    ...(!legacy ? { views: () => views } : {}),
    openReadable: async (opts) => {
      const feed = new PassThrough();
      const opened = { opts, feed, view: opts?.view ?? 0 };
      calls.opens.push(opened);
      queueMicrotask(() => feed.write(Buffer.from(`optic-${opened.view}`)));
      return feed;
    },
    snapshotLive: async (opts) => {
      calls.snapshots.push(opts);
      if (calls.snapshotError) throw new Error("synthetic view unavailable");
      return { jpeg: Buffer.from(`jpeg-optic-${opts?.view ?? 0}`) };
    },
    snapshotStored: async () => {
      calls.stored++;
      return Buffer.from("unselected-event-image");
    },
  };
  if (liveOnly) {
    delete camera.openReadable;
    camera.live = async (opts) => {
      const consumer = new EventEmitter();
      const opened = { opts, view: opts?.view ?? 0, stopped: false };
      calls.opens.push(opened);
      consumer.stop = () => {
        opened.stopped = true;
      };
      setImmediate(() => consumer.emit("video", { data: Buffer.from(`optic-${opened.view}`) }));
      return consumer;
    };
  }
  const device = {
    describe: () => ({
      ...record,
      codec: "camera",
      modelName: "PoE Cam S4",
      capabilities: ["camera", "video", "ptz"],
      details: [],
    }),
    getProperties: () => ({}),
    camera: () => camera,
  };
  const eufy = { getDevices: async () => [record], getDevice: async () => device };
  const lease = Promise.resolve(eufy);
  const ctx = {
    ...loadConfig({ EUFY_EMAIL: "synthetic@example.invalid", EUFY_PASSWORD: "synthetic" }),
    state,
    eufy,
    eventImageDir: dir,
    eventLog() {},
    broadcast() {},
    dbg() {},
    SCHEMA_VERSION: 1,
    authStatus: () => ({ state: "ok" }),
    streamClientFor: () => lease,
    dropStreamClient: () => calls.dropped++,
    noteStreamFailure: () => calls.failures++,
    noteStreamOpened() {},
  };
  ctx.cfg.streamBatteryBudgetMs = 12345;
  ctx.cfg.streamInstantStart = false;
  Object.assign(ctx, createDeviceView(ctx));
  const server = http.createServer((req, res) => void handler(req, res));
  const handler = createHttpHandler(ctx);
  Object.assign(ctx, createWsServer(ctx, server));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function ws(cmd, extra = {}) {
    const replies = [];
    await ctx.handleMessage(
      { readyState: 1, OPEN: 1, send: (s) => replies.push(JSON.parse(s)) },
      Buffer.from(JSON.stringify({ id: 1, cmd, sn: SN, ...extra })),
    );
    return replies[0];
  }
  async function pull(query = "") {
    const response = await fetch(`${base}/stream/${SN}${query}`);
    const reader = response.body.getReader();
    if (response.status !== 200) return { response, body: (await reader.read()).value };
    const first = Buffer.from((await reader.read()).value).toString();
    return { response, reader, first };
  }
  return { ctx, calls, camera, dir, base, ws, pull };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("expected lifecycle transition did not occur");
}

test("devices.list and device.state advertise the SDK's views with stable primary addresses", async (t) => {
  const h = await setup(t);
  const list = await h.ws("devices.list");
  const single = await h.ws("device.state");
  assert.deepEqual(list.devices[0], single.device);
  assert.equal(single.device.stream, `/stream/${SN}`);
  assert.deepEqual(single.device.views, [
    { view: 0, id: SN, stream: `/stream/${SN}`, snapshot: `/snapshot/${SN}` },
    { view: 1, id: `${SN}_view_1`, stream: `/stream/${SN}?view=1`, snapshot: `/snapshot/${SN}?view=1` },
  ]);
  assert.equal(h.calls.opens.length, 0);
});

test("Full HD flows through advertised sources, HTTP and go2rtc without replacing default views", async (t) => {
  const h = await setup(t, { outputs: ["1080p"] });
  const reply = await h.ws("devices.list");
  const views = reply.devices[0].views;
  assert.equal(views[0].id, SN);
  assert.equal(views[1].id, `${SN}_view_1`);
  assert.equal(views[1].outputs[0].outputResolution, "1080p");
  assert.equal(views[1].outputs[0].id, `${SN}_view_1_output_1080p`);
  const start = await h.ws("stream.start", { view: 1, outputResolution: "1080p" });
  assert.match(start.rtsp, new RegExp(`${SN}_view_1_output_1080p$`));
  const pulled = await h.pull("?view=1&outputResolution=1080p");
  assert.equal(pulled.response.status, 200);
  assert.equal(h.calls.opens[0].opts.outputResolution, "1080p");
  assert.equal(h.calls.opens[0].opts.view, 1);
  await pulled.reader.cancel();
  h.ctx.cfg.go2rtcConfig = path.join(h.dir, "go2rtc.yaml");
  await writeGo2rtcConfig(h.ctx.cfg, reply.devices);
  const config = await fs.readFile(h.ctx.cfg.go2rtcConfig, "utf8");
  assert.match(config, new RegExp(`${SN}_view_1_output_1080p:.*view=1&outputResolution=1080p`));
});

test("unsupported or malformed Full-HD selections do not open media or hide behind instant start", async (t) => {
  const h = await setup(t);
  h.ctx.cfg.streamInstantStart = true;
  for (const query of [
    "?outputResolution=1080p",
    "?outputResolution=4K",
    "?outputResolution=1080p&outputResolution=1080p",
  ]) {
    const r = await h.pull(query);
    assert.ok([400, 404].includes(r.response.status));
  }
  assert.equal(h.calls.opens.length, 0);
  assert.equal(h.calls.failures, 0);
  const start = await h.ws("stream.start", { outputResolution: "1080p" });
  assert.ok(start.error);
});

test("legacy SDKs and single-view cameras retain one primary source", async (t) => {
  for (const opts of [{ legacy: true }, { views: [0], model: "T8P00" }]) {
    const h = await setup(t, opts);
    const result = await h.ws("device.state");
    assert.deepEqual(result.device.views, [{ view: 0, id: SN, stream: `/stream/${SN}`, snapshot: `/snapshot/${SN}` }]);
  }
});

test("view discovery follows the SDK rather than a model or consecutive-view assumption", async (t) => {
  const h = await setup(t, { model: "SYNTHETIC", views: [0, 2] });
  assert.deepEqual(
    (await h.ws("device.state")).device.views.map((v) => v.view),
    [0, 2],
  );
});

test("go2rtc registers each advertised view without replacing the primary source", async (t) => {
  const h = await setup(t);
  const devices = (await h.ws("devices.list")).devices;
  const file = path.join(h.dir, "go2rtc.yaml");
  await writeGo2rtcConfig({ go2rtcConfig: file, selfHost: "127.0.0.1", port: 3000 }, devices);
  const yaml = await fs.readFile(file, "utf8");
  assert.ok(yaml.includes(`${SN}: ffmpeg:http://127.0.0.1:3000/stream/${SN}#video=copy#async`));
  assert.ok(yaml.includes(`${SN}_view_1: ffmpeg:http://127.0.0.1:3000/stream/${SN}?view=1#video=copy#async`));
});

test("stream.start selects an advertised view and returns URLs without opening video", async (t) => {
  const h = await setup(t);
  const reply = await h.ws("stream.start", { view: 1 });
  assert.equal(reply.path, `/stream/${SN}?view=1`);
  assert.equal(reply.rtsp, `rtsp://${h.ctx.cfg.selfHost}:8554/${SN}_view_1`);
  assert.equal(h.calls.opens.length, 0);
  assert.equal((await h.ws("stream.start", { view: 9 })).ok, false);
  assert.equal((await h.ws("stream.start", { view: "1" })).ok, false);
  assert.equal((await h.ws("stream.start", { view: null })).ok, false);
  assert.equal((await h.ws("stream.start")).path, `/stream/${SN}`);
});

test("HTTP selects each optic, retains battery budget and releases only the departing viewer", async (t) => {
  const h = await setup(t);
  const primary = await h.pull();
  const other = await h.pull("?view=1");
  assert.equal(primary.first, "optic-0");
  assert.equal(other.first, "optic-1");
  assert.deepEqual(h.calls.opens[1].opts, { batteryBudgetMs: 12345, view: 1 });
  await primary.reader.cancel();
  await until(() => h.calls.opens[0].feed.destroyed);
  assert.equal(h.calls.opens[1].feed.destroyed, false);
  assert.equal(h.ctx.state.streaming.has(SN), true);
  await other.reader.cancel();
  await until(() => !h.ctx.state.streaming.has(SN));
  assert.equal(h.calls.dropped, 0);
});

test("invalid and unsupported HTTP view selectors fail before media without failure backoff", async (t) => {
  const h = await setup(t);
  for (const route of ["stream", "snapshot"]) {
    for (const query of [
      "view=-1",
      "view=1.5",
      "view=",
      "view=x",
      "view=01",
      "view=9007199254740992",
      "view=1&view=0",
    ]) {
      const response = await fetch(`${h.base}/${route}/${SN}?${query}`);
      await response.body.cancel();
      assert.equal(response.status, 400, `${route}?${query}`);
    }
    const unsupported = await fetch(`${h.base}/${route}/${SN}?view=9`);
    await unsupported.body.cancel();
    assert.equal(unsupported.status, 404);
  }
  assert.equal(h.calls.opens.length, 0);
  assert.equal(h.calls.snapshots.length, 0);
  assert.equal(h.calls.failures, 0);
});

test("an older SDK rejects a secondary view rather than silently returning the primary", async (t) => {
  const h = await setup(t, { legacy: true });
  const response = await fetch(`${h.base}/snapshot/${SN}?view=1`);
  await response.body.cancel();
  assert.equal(response.status, 404);
  assert.equal(h.calls.snapshots.length, 0);
});

test("optical-view selection retains the HTTP and WebSocket authentication gates", async (t) => {
  const h = await setup(t);
  h.ctx.state.flags.ready = false;
  assert.equal((await h.ws("devices.list")).ok, false);
  assert.equal((await h.ws("stream.start", { view: 1 })).ok, false);
  const response = await fetch(`${h.base}/stream/${SN}?view=1`);
  await response.body.cancel();
  assert.equal(response.status, 503);
  assert.equal(h.calls.opens.length, 0);
});

test("snapshot forwards the selected optic and retains its own still for a stored-mode read", async (t) => {
  const h = await setup(t);
  const response = await fetch(`${h.base}/snapshot/${SN}?view=1&mode=live`);
  assert.equal(await response.text(), "jpeg-optic-1");
  assert.deepEqual(h.calls.snapshots, [{ view: 1 }]);
  h.calls.snapshotError = true;
  const stored = await fetch(`${h.base}/snapshot/${SN}?view=1&mode=stored`);
  assert.equal(stored.status, 200);
  assert.equal(await stored.text(), "jpeg-optic-1");
  assert.equal(h.calls.snapshots.length, 1);
  assert.equal(h.calls.stored, 0);
});

test("secondary snapshots never fall back to a primary live picture or an unselected event image", async (t) => {
  const h = await setup(t);
  await fs.writeFile(path.join(h.dir, `last-live-${SN}.jpg`), "primary-live");
  await fs.writeFile(path.join(h.dir, `last-event-${SN}.jpg`), "primary-event");
  h.calls.snapshotError = true;
  const response = await fetch(`${h.base}/snapshot/${SN}?view=1&mode=live`);
  await response.body.cancel();
  assert.equal(response.status, 404);
  assert.equal(h.calls.stored, 0);
});

test("an unsupported view cannot read an old per-view cache", async (t) => {
  const h = await setup(t, { views: [0] });
  await fs.writeFile(path.join(h.dir, `last-live-${SN}_view_1.jpg`), "old-secondary");
  const response = await fetch(`${h.base}/snapshot/${SN}?view=1&mode=stored`);
  await response.body.cancel();
  assert.equal(response.status, 404);
});

test("instant start primes the primary view only, so an unsupported view still answers 404", async (t) => {
  const h = await setup(t);
  h.ctx.cfg.streamInstantStart = true;
  h.ctx.cfg.streamPlaceholder = true;
  const invalid = await h.pull("?view=9");
  assert.equal(invalid.response.status, 404);
  assert.equal(h.calls.opens.length, 0);
  const secondary = await h.pull("?view=1");
  assert.equal(secondary.response.status, 200);
  assert.equal(secondary.first, "optic-1");
  await secondary.reader.cancel();
});

test("selected optics preserve the live-only fallback and generic binary response", async (t) => {
  const h = await setup(t, { liveOnly: true });
  const other = await h.pull("?view=1");
  assert.equal(other.response.status, 200);
  assert.equal(other.response.headers.get("content-type"), "application/octet-stream");
  assert.equal(other.first, "optic-1");
  assert.deepEqual(h.calls.opens[0].opts, { batteryBudgetMs: 12345, view: 1 });
  const invalid = await h.pull("?view=9");
  assert.equal(invalid.response.status, 404);
  assert.equal(h.calls.opens.length, 1);
  await other.reader.cancel();
  await until(() => h.calls.opens[0].stopped);
});

test("selected optical sources retain configured go2rtc ports", async (t) => {
  const h = await setup(t);
  Object.assign(h.ctx.cfg, { go2rtcApiPort: 11984, go2rtcRtspPort: 18554, go2rtcWebrtcPort: 18555 });
  const reply = await h.ws("stream.start", { view: 1 });
  assert.equal(reply.rtsp, `rtsp://${h.ctx.cfg.selfHost}:18554/${SN}_view_1`);
  const file = path.join(h.dir, "ports.yaml");
  await writeGo2rtcConfig({ ...h.ctx.cfg, go2rtcConfig: file }, (await h.ws("devices.list")).devices);
  const yaml = await fs.readFile(file, "utf8");
  for (const port of [11984, 18554, 18555]) assert.ok(yaml.includes(`listen: ":${port}"`));
  assert.ok(yaml.includes(`${SN}_view_1: ffmpeg:http://${h.ctx.cfg.selfHost}:${h.ctx.cfg.port}/stream/${SN}?view=1`));
});
