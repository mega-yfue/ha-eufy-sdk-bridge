// Which cameras the bridge treats as battery-powered (see power.mjs). The `battery` capability alone is not
// the answer: the SDK's mains-only models (the T8423 floodlight, ha-eufy-sdk-bridge#101) still resolve it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onBatteryPower } from "../src/power.mjs";
import { createStreamIdle } from "../src/stream-idle.mjs";
import { createState } from "../src/state.mjs";

test("a battery camera is on battery power", () => {
  assert.equal(onBatteryPower("T8170", ["camera", "battery"]), true);
});

test("a mains-only model is not, even when it resolves the battery capability", () => {
  assert.equal(onBatteryPower("T8423", ["camera", "light", "battery"]), false);
});

test("a camera without the battery capability is not", () => {
  assert.equal(onBatteryPower("T8410", ["camera", "ptz"]), false);
  assert.equal(onBatteryPower(undefined, undefined), false);
});

test("the rtspStream auto-off skips a mains camera and still turns a battery one off", async () => {
  const state = createState();
  state.flags.ready = true;
  const writes = [];
  const devices = [
    { sn: "MAINS", model: "T8423", capabilities: ["battery"], state: { rtspStream: true } },
    { sn: "BATT", model: "T8170", capabilities: ["battery"], state: { rtspStream: true } },
  ];
  const idle = createStreamIdle({
    cfg: { rtspIdleOffMs: 1 },
    state,
    deviceList: async () => devices,
    eufy: { setProperty: async (sn, name, value) => void writes.push([sn, name, value]) },
  });
  await idle.rtspIdleSweep(); // first sight starts each camera's idle window
  await new Promise((r) => setTimeout(r, 5));
  await idle.rtspIdleSweep();
  assert.deepEqual(writes, [["BATT", "rtspStream", false]]);
});
