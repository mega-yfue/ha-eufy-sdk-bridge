import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { armingWire, withArmingMode } from "../src/arming-mode.mjs";
import { createBoot } from "../src/boot.mjs";
import { DETECTION_EVENTS, FORWARDED_EVENTS } from "../src/config.mjs";

/** A client whose devices answer `armingMode` from `modes` (sn → value); a missing sn throws like the SDK. */
function fakeEufy(modes) {
  const eufy = new EventEmitter();
  eufy.getDevice = async (sn) => {
    if (!(sn in modes)) throw new Error(`no device ${sn}`);
    const value = modes[sn];
    return { getProperties: () => (value === undefined ? {} : { armingMode: { value } }) };
  };
  eufy.getDevices = async () => [];
  return eufy;
}

test("armingWire: either vocabulary as the wire integer", () => {
  assert.equal(armingWire(63), 63);
  assert.equal(armingWire("63"), 63);
  assert.equal(armingWire("home"), 1);
  assert.equal(armingWire("away"), 0);
  assert.equal(armingWire("nonsense"), undefined);
  assert.equal(armingWire(undefined), undefined);
  assert.equal(armingWire(1.5), undefined);
});

test("withArmingMode: adds the station's current mode", async () => {
  const eufy = fakeEufy({ HB: 63 });
  assert.deepEqual(await withArmingMode(eufy, { deviceSn: "HB" }), { deviceSn: "HB", mode: 63 });
});

test("withArmingMode: leaves the payload alone when the mode cannot be read", async () => {
  const eufy = fakeEufy({ NOMODE: undefined });
  assert.deepEqual(await withArmingMode(eufy, { deviceSn: "NOMODE" }), { deviceSn: "NOMODE" });
  assert.deepEqual(await withArmingMode(eufy, { deviceSn: "GONE" }), { deviceSn: "GONE" });
  assert.deepEqual(await withArmingMode(eufy, {}), {});
});

/** Boot the event wiring against a fake client and collect what reaches the WS clients. */
async function boot(eufy) {
  const sent = [];
  const state = { flags: {}, timers: {}, clients: new Set() };
  const ctx = {
    cfg: {
      go2rtcEnable: false,
      go2rtcConfig: path.join(os.tmpdir(), `go2rtc-arming-test-${process.pid}.yaml`),
      streamIdleMs: 0,
      rtspIdleOffMs: 0,
    },
    eufy,
    DEBUG: false,
    SCHEMA_VERSION: 1,
    dbg: () => {},
    DETECTION_EVENTS,
    FORWARDED_EVENTS,
    state,
    broadcast: (obj) => sent.push(obj),
    enrichPersonName: (_e, payload) => payload,
    eventLog: () => {},
    deviceList: async () => [],
    warmFaceRoster: async () => {},
    warmLastEventImages: async () => {},
    watchdogTick: async () => {},
  };
  await createBoot(ctx).completeBoot();
  clearInterval(state.timers.watchdog);
  fs.rmSync(ctx.cfg.go2rtcConfig, { force: true });
  return sent;
}

const settle = () => new Promise((r) => setImmediate(r));

test("boot: a forwarded armingModeChanged carries the mode the station is now in", async () => {
  const eufy = fakeEufy({ HB: 1 });
  const sent = await boot(eufy);
  eufy.emit("armingModeChanged", { deviceSn: "HB" });
  await settle();
  assert.deepEqual(
    sent.filter((m) => m.event === "armingModeChanged"),
    [{ event: "armingModeChanged", deviceSn: "HB", mode: 1 }],
  );
});

test("boot: an armingModeChanged whose mode cannot be read is still forwarded, without a mode", async () => {
  const eufy = fakeEufy({});
  const sent = await boot(eufy);
  eufy.emit("armingModeChanged", { deviceSn: "GONE" });
  await settle();
  assert.deepEqual(
    sent.filter((m) => m.event === "armingModeChanged"),
    [{ event: "armingModeChanged", deviceSn: "GONE" }],
  );
});

test("boot: other events are forwarded as before", async () => {
  const eufy = fakeEufy({ CAM: 1 });
  const sent = await boot(eufy);
  eufy.emit("propertyChanged", { deviceSn: "CAM", property: "brightness", value: 90 });
  assert.deepEqual(
    sent.filter((m) => m.event === "propertyChanged"),
    [{ event: "propertyChanged", deviceSn: "CAM", property: "brightness", value: 90 }],
  );
});
