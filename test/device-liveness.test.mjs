import { test } from "node:test";
import assert from "node:assert/strict";

import { createDeviceView } from "../src/device-view.mjs";

/** A minimal device the view can describe. */
function fakeDevice(sn) {
  return {
    describe: () => ({
      sn,
      name: sn,
      model: "T817L",
      modelName: "eufyCam",
      codec: "camera",
      capabilities: ["camera", "video", "battery"],
    }),
    getProperties: () => ({ battery: { value: 60 } }),
  };
}

/** Build the device view over a fake SDK that answers the liveness accessors. */
function view(liveness) {
  const eufy = {
    async getDevice(sn) {
      return fakeDevice(sn);
    },
    getP2pSessions: () => new Map(),
    ...liveness,
  };
  return createDeviceView({ eufy, state: { streaming: new Set() } });
}

test("device view surfaces lastSeenMs and the explicit availability observation", async () => {
  const lastSeenMs = 1_700_000_000_000;
  const { describeDevice } = view({
    deviceState: () => ({ sn: "CAM1", stationSn: "CAM1", lastSeenMs }),
    deviceAvailability: () => ({ availability: "available" }),
  });
  const rec = await describeDevice("CAM1");
  assert.equal(rec.lastSeenMs, lastSeenMs);
  assert.equal(rec.availability, "available");
});

test("device view omits the liveness facts the SDK has nothing to report", async () => {
  // deviceState returns no lastSeenMs; deviceAvailability has no observation.
  const { describeDevice } = view({
    deviceState: () => ({ sn: "CAM1", stationSn: "CAM1" }),
    deviceAvailability: () => undefined,
  });
  const rec = await describeDevice("CAM1");
  assert.ok(!("lastSeenMs" in rec));
  assert.ok(!("availability" in rec));
});

test("device view works against an SDK that lacks the liveness accessors", async () => {
  const { describeDevice } = view({ getP2pSessions: undefined }); // older SDK
  const rec = await describeDevice("CAM1");
  assert.ok(!("lastSeenMs" in rec));
  assert.ok(!("availability" in rec));
  assert.ok(!("p2pReachable" in rec));
  assert.equal(rec.sn, "CAM1"); // the rest of the record is unaffected
});

test("device view reports p2pReachable for a standalone device with a live session", async () => {
  // A session keyed by the device's own serial = a standalone device whose transport is up.
  const { describeDevice } = view({
    getP2pSessions: () => new Map([["CAM1", { isConnected: true }]]),
  });
  const rec = await describeDevice("CAM1");
  assert.equal(rec.p2pReachable, true);
});

test("device view omits p2pReachable when a stray session can't be tied to the device's station", async () => {
  // No deviceState → the device's station is unknown, so a session keyed by some other serial (HB1)
  // can't be attributed to this device and the field stays absent.
  const { describeDevice } = view({
    getP2pSessions: () => new Map([["HB1", { isConnected: true }]]),
  });
  const rec = await describeDevice("CAM1");
  assert.ok(!("p2pReachable" in rec));
});

test("device view reports p2pReachable for a HomeBase-attached device when its station's session is live", async () => {
  // The camera's session is keyed by its station (HB1), which is connected — the bridge reaches the
  // child through the parent, so it is reachable even though CAM1 itself keys no session.
  const { describeDevice } = view({
    deviceState: () => ({ sn: "CAM1", stationSn: "HB1" }),
    getP2pSessions: () => new Map([["HB1", { isConnected: true }]]),
  });
  const rec = await describeDevice("CAM1");
  assert.equal(rec.p2pReachable, true);
});

test("device view omits p2pReachable for an attached device when its station's session is down", async () => {
  // Station known but its session is not connected → no live transport, so staleness decides (field absent).
  const { describeDevice } = view({
    deviceState: () => ({ sn: "CAM1", stationSn: "HB1" }),
    getP2pSessions: () => new Map([["HB1", { isConnected: false }]]),
  });
  const rec = await describeDevice("CAM1");
  assert.ok(!("p2pReachable" in rec));
});

test("device view names the station a HomeBase-attached device hangs off", async () => {
  const { describeDevice } = view({
    deviceState: () => ({ sn: "CAM1", stationSn: "HB1", lastSeenMs: 1_700_000_000_000 }),
  });
  const rec = await describeDevice("CAM1");
  assert.equal(rec.stationSn, "HB1");
});

test("device view names a standalone device as its own station", async () => {
  const { describeDevice } = view({ deviceState: () => ({ sn: "CAM1", stationSn: "CAM1" }) });
  const rec = await describeDevice("CAM1");
  assert.equal(rec.stationSn, "CAM1");
});

test("a camera advertises its last screen, a device without video does not", async () => {
  const { describeDevice } = view({ deviceState: () => ({ sn: "CAM1", stationSn: "CAM1" }) });
  assert.equal((await describeDevice("CAM1")).lastScreen, "/last-screen/CAM1");
  const sensor = {
    describe: () => ({ sn: "S1", name: "S1", model: "T8900", modelName: "Sensor", codec: "sensor", capabilities: [] }),
    getProperties: () => ({}),
  };
  const eufy = { getDevice: async () => sensor, getP2pSessions: () => new Map() };
  const rec = await createDeviceView({ eufy, state: { streaming: new Set() } }).describeDevice("S1");
  assert.equal(rec.lastScreen, undefined);
});
