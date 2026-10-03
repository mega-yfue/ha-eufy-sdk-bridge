import test from "node:test";
import assert from "node:assert/strict";

import { createDeviceView } from "../src/device-view.mjs";

test("device view retains SDK Device instances while they remain in the roster", async () => {
  let gets = 0;
  let roster = [{ sn: "DEVICE1" }];

  const device = {
    describe: () => ({
      sn: "DEVICE1",
      name: "Camera",
      model: "T0000",
      modelName: "Camera",
      codec: "camera",
      capabilities: ["camera"],
    }),
    getProperties: () => ({
      enabled: { value: true },
    }),
  };

  const eufy = {
    async getDevice(sn) {
      assert.equal(sn, "DEVICE1");
      gets++;
      return device;
    },
    async getDevices() {
      return roster;
    },
  };

  const view = createDeviceView({
    eufy,
    state: { streaming: new Set() },
  });

  await view.describeDevice("DEVICE1");
  await view.describeDevice("DEVICE1");

  assert.equal(gets, 1);

  await view.deviceList();

  assert.equal(gets, 1);

  roster = [];
  await view.deviceList();

  await view.describeDevice("DEVICE1");

  assert.equal(gets, 2);
});
