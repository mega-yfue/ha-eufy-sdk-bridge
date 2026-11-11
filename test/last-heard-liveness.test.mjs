import { test } from "node:test";
import assert from "node:assert/strict";

import { createDeviceView } from "../src/device-view.mjs";
import { createActivity } from "../src/activity.mjs";

// A battery eufyCam (6h local-activity window). The cloud `lastSeen` lies for it when it reports to its
// HomeBase but not the cloud, so "heard locally" is what proves it alive.
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

const HOUR = 60 * 60 * 1000;

/** Build the view over a fake SDK + a `heardMs` the test controls. */
function view({ liveness = {}, heardMs } = {}) {
  const eufy = {
    async getDevice(sn) {
      return fakeDevice(sn);
    },
    getP2pSessions: () => new Map(),
    ...liveness,
  };
  return createDeviceView({ eufy, state: { streaming: new Set() }, heardMs });
}

test("camera with no session but heard within its window reads as p2pReachable", async () => {
  const now = Date.now();
  const { describeDevice } = view({ heardMs: () => now - 1000 }); // heard a second ago
  const rec = await describeDevice("CAM1");
  assert.equal(rec.p2pReachable, true);
});

test("camera heard OUTSIDE its window is not p2pReachable (staleness decides)", async () => {
  const { describeDevice } = view({ heardMs: () => Date.now() - 7 * HOUR }); // past the 6h battery window
  const rec = await describeDevice("CAM1");
  assert.ok(!("p2pReachable" in rec));
});

test("camera never heard from and with no session is unchanged (no p2pReachable)", async () => {
  const { describeDevice } = view({ heardMs: () => undefined });
  const rec = await describeDevice("CAM1");
  assert.ok(!("p2pReachable" in rec));
});

test("a live P2P session still wins even when the device was never heard from", async () => {
  const { describeDevice } = view({
    liveness: { getP2pSessions: () => new Map([["CAM1", { isConnected: true }]]) },
    heardMs: () => undefined,
  });
  const rec = await describeDevice("CAM1");
  assert.equal(rec.p2pReachable, true);
});

test("createActivity notes and reads back the last-heard clock; noteActivity makes it reachable", async () => {
  const activity = createActivity();
  assert.equal(activity.heardMs("CAM1"), undefined); // never heard
  activity.noteActivity(""); // falsy serial is ignored
  assert.equal(activity.heardMs(""), undefined);
  activity.noteActivity("CAM1");
  assert.equal(typeof activity.heardMs("CAM1"), "number");

  const { describeDevice } = view({ heardMs: activity.heardMs });
  const rec = await describeDevice("CAM1");
  assert.equal(rec.p2pReachable, true);
});
