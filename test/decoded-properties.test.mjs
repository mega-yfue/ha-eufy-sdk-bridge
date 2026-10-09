import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Device } from "@mega-yfue/eufy-sdk";
import { createDeviceView } from "../src/device-view.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";

const sn = "EXAMPLE-CAM-0001";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const quality = (tier) => encode({ cur_mode: 0, mode_0: { quality: tier } });

function camera(params = { 2731: quality(2) }) {
  const dev = Device.fromRecord(sn, { model: "T8425", params });
  dev.bindActions(
    { codec: "camera", model: "T8425", channel: 0, paramIds: new Set(Object.keys(params).map(Number)) },
    { dispatch: async () => assert.fail("a read must not dispatch a command") },
  );
  return dev;
}

function view(dev) {
  return createDeviceView({
    eufy: { getDevice: async () => dev, getDevices: async () => [{ sn }] },
    state: { streaming: new Set() },
  });
}

test("published SDK decodes recording quality while raw state and raw schema stay intact", async () => {
  const dev = camera();
  const api = view(dev);
  const raw = api.propertyState(dev);
  const properties = api.propertySpecs(dev);
  const summary = await api.describeDevice(sn);
  assert.deepEqual(summary.state, raw);
  assert.deepEqual(summary.state.recordingQuality, { cur_mode: 0, mode_0: { quality: 2 } });
  assert.equal(summary.decodedState.camera.recordingQuality, 2);
  assert.deepEqual(api.propertySpecs(dev), properties);
  const manifest = api.decodedProperties(dev);
  assert.equal(Object.hasOwn(summary, "decodedProperties"), false);
  const read = manifest.details
    .find((cap) => cap.accessor === "camera")
    .reads.find((r) => r.property === "recordingQuality");
  assert.deepEqual(
    read,
    dev
      .describe()
      .details.find((cap) => cap.accessor === "camera")
      .reads.find((r) => r.property === "recordingQuality"),
  );
  assert.equal(read.type, "string"); // SDK storage type; kind/values describe the decoded enum.
  assert.equal(read.kind, "enum");
  assert.deepEqual(read.values, [1, 2, 3]);
  assert.equal(read.labels["2"], "Full HD (1080P)");
  assert.equal(manifest.bound, true);
});

test("new reports are read live, malformed reports clear the decoded value, and absent reads stay absent", async () => {
  const dev = camera();
  const api = view(dev);
  dev.applyParams({ 2731: quality(3) });
  assert.equal((await api.describeDevice(sn)).decodedState.camera.recordingQuality, 3);
  dev.applyParams({ 2731: "malformed" });
  assert.equal((await api.describeDevice(sn)).decodedState.camera.recordingQuality, null);
  const missing = camera({});
  const missingApi = view(missing);
  assert.equal(Object.hasOwn((await missingApi.describeDevice(sn)).decodedState.camera, "recordingQuality"), false);
  assert.equal(
    missingApi.decodedProperties(missing).details.some((c) => c.reads.some((r) => r.property === "recordingQuality")),
    false,
  );
});

test("unbound models are explicit and do not invent reads", async () => {
  const dev = Device.fromRecord(sn, { model: "T8425" });
  assert.deepEqual(view(dev).decodedProperties(dev), { bound: false, details: [] });
  assert.deepEqual((await view(dev).describeDevice(sn)).decodedState, {});
});

test("manifest metadata does not read values; a stale snapshot retains SDK refresh coalescing", async () => {
  const dev = camera();
  let refreshes = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  dev.setFreshnessPolicy({
    staleAfterMs: -1,
    refresh: () => {
      refreshes++;
      return pending;
    },
  });
  const api = view(dev);
  api.decodedProperties(dev);
  assert.equal(refreshes, 0);
  try {
    await api.describeDevice(sn);
    assert.equal(refreshes, 1);
  } finally {
    release();
    await pending;
  }
});

function synthetic(surfaces, details) {
  return {
    describe: () => ({ sn, capabilities: [], bound: true, details }),
    getProperties: () => ({ example: { value: "raw" } }),
    ...Object.fromEntries(Object.entries(surfaces).map(([name, surface]) => [name, () => surface])),
  };
}

test("capability namespaces preserve colliding properties, false, zero and text enums without invoking actions", async () => {
  const dev = synthetic(
    {
      first: { value: 0, action: () => assert.fail("action invoked") },
      second: { value: false, mode: "auto" },
    },
    [
      {
        capability: "first",
        accessor: "first",
        reads: [{ accessor: "value", property: "shared" }],
        actions: [{ name: "action" }],
      },
      {
        capability: "second",
        accessor: "second",
        reads: [
          { accessor: "value", property: "shared" },
          { accessor: "mode", property: "mode", kind: "enum", values: ["auto", "manual"] },
        ],
      },
    ],
  );
  assert.deepEqual((await view(dev).describeDevice(sn)).decodedState, {
    first: { value: 0 },
    second: { value: false, mode: "auto" },
  });
});

test("decoder failures and non-scalars are bounded diagnostics and do not break raw snapshots", async () => {
  const surface = { object: {}, infinity: Infinity, empty: "", absent: undefined };
  Object.defineProperty(surface, "broken", {
    get: () => {
      throw new Error("private decoder details");
    },
  });
  const dev = synthetic({ sample: surface }, [
    {
      capability: "sample",
      accessor: "sample",
      reads: ["object", "infinity", "empty", "absent", "broken"].map((accessor) => ({ accessor, property: accessor })),
    },
  ]);
  const result = await view(dev).describeDevice(sn);
  assert.deepEqual(result.state, { example: "raw" });
  assert.deepEqual(result.decodedState.sample, { object: null, infinity: null, empty: "", absent: null, broken: null });
  assert.deepEqual(
    result.decodedErrors.map((e) => e.error),
    ["non_scalar", "non_scalar", "read_failed"],
  );
  assert.equal(JSON.stringify(result).includes("private decoder details"), false);
});

test("snapshot and schema follow replaced models rather than a stale projection cache", async () => {
  let current = camera();
  const api = createDeviceView({ eufy: { getDevice: async () => current }, state: { streaming: new Set() } });
  assert.equal((await api.describeDevice(sn)).decodedState.camera.recordingQuality, 2);
  current = camera({});
  const replaced = await api.describeDevice(sn);
  assert.equal(Object.hasOwn(replaced.decodedState.camera, "recordingQuality"), false);
  assert.equal(
    api.decodedProperties(current).details.some((c) => c.reads.some((r) => r.property === "recordingQuality")),
    false,
  );
});

test("a snapshot evaluates the read manifest once without repeating metadata", async () => {
  const dev = camera();
  const describe = dev.describe.bind(dev);
  let calls = 0;
  dev.describe = () => {
    assert.equal(++calls, 1, "metadata must not be independently described during the snapshot");
    return describe();
  };
  const snapshot = await view(dev).describeDevice(sn);
  assert.equal(snapshot.decodedState.camera.recordingQuality, 2);
  assert.equal(Object.hasOwn(snapshot, "decodedProperties"), false);
  assert.equal(calls, 1);
});

test("WebSocket schema-1 replies add decoded fields without changing legacy fields or bypassing auth", async () => {
  const dev = camera();
  const state = createState();
  const ctx = {
    cfg: {},
    eufy: { getDevice: async () => dev, getDevices: async () => [{ sn }] },
    state,
    SCHEMA_VERSION: 1,
    DEBUG: false,
    dbg: () => {},
    authStatus: () => ({ state: "pending" }),
  };
  Object.assign(ctx, createDeviceView(ctx));
  const server = http.createServer(); // no listening socket or cloud session
  Object.assign(ctx, createWsServer(ctx, server));
  async function call(cmd) {
    const sent = [];
    await ctx.handleMessage(
      { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) },
      Buffer.from(JSON.stringify({ id: 1, cmd, sn })),
    );
    return sent[0];
  }
  try {
    assert.equal((await call("device.properties")).ok, false);
    state.flags.ready = true;
    const properties = await call("device.properties");
    assert.equal(properties.ok, true);
    assert.deepEqual(properties.properties, JSON.parse(JSON.stringify(ctx.propertySpecs(dev))));
    assert.equal(properties.decodedProperties.bound, true);
    const snapshot = await call("device.state");
    const list = await call("devices.list");
    assert.deepEqual(snapshot.device, list.devices[0]);
    assert.deepEqual(snapshot.device.state, ctx.propertyState(dev));
    assert.equal(snapshot.device.decodedState.camera.recordingQuality, 2);
    assert.equal(Object.hasOwn(snapshot.device, "decodedProperties"), false);
    assert.equal(Object.hasOwn(list.devices[0], "decodedProperties"), false);
  } finally {
    server.close();
  }
});

test("an events-only capability (no accessor, eufy-sdk 0.4.0+) is left out of the decoded readings", async () => {
  const dev = camera();
  const api = view(dev);
  // The real SDK manifest for this camera carries `person_detection` with no accessor.
  assert.ok(dev.describe().details.some((cap) => cap.accessor === undefined));
  const summary = await api.describeDevice(sn);
  assert.equal(Object.hasOwn(summary.decodedState, "undefined"), false);
  assert.equal(summary.decodedState.camera.recordingQuality, 2);
  const { details } = api.decodedProperties(dev);
  assert.ok(details.length > 0);
  assert.ok(details.every((cap) => typeof cap.accessor === "string" && cap.accessor.length > 0));
});
