// #35 night-vision upgrade: latestTriggerType reads the freshest history_record_info record's
// trigger_type (HB3: 2=motion, 4=person), even for a crop-less record.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createWarmup } from "../src/warmup.mjs";

function fakeStation(direct) {
  const s = new EventEmitter();
  s.isConnected = true;
  s.queryDatabase = (_table, opts) => {
    if (opts.innerCmd === 10000) setTimeout(() => s.emit("dbChunk", { text: JSON.stringify(direct()) }), 0);
  };
  s.requestImage = () => {};
  return s;
}

function setup(direct) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-"));
  return createWarmup({
    eventImageDir: dir,
    eventLog: () => {},
    broadcast: () => {},
    state: { faceNames: new Map() },
    eufy: {
      getP2pSessions: () => new Map([["HB3", fakeStation(direct)]]),
      getDevices: async () => [{ sn: "HB3", p2pDid: "EUPREMB-0-0" }],
    },
  });
}

/** Run under mocked timers, ticking until the DB read settles. */
async function run(fn) {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let done = false;
    const p = fn().finally(() => (done = true));
    while (!done) {
      mock.timers.tick(200);
      await new Promise((r) => setImmediate(r));
    }
    return await p;
  } finally {
    mock.timers.reset();
  }
}

test("latestTriggerType returns the freshest record's trigger_type", async () => {
  const warm = setup(() => ({
    data: [
      { device_sn: "CAM1", record_id: 1, trigger_type: 2, payload: { crop_hb3_path: "a.jpg" } },
      { device_sn: "CAM1", record_id: 2, trigger_type: 4, payload: {} }, // newest, person, no crop
    ],
  }));
  assert.equal(await run(() => warm.latestTriggerType("CAM1")), 4);
});

test("latestTriggerType reads a top-level or payload trigger_type, newest wins", async () => {
  const warm = setup(() => ({
    data: [
      { device_sn: "CAM1", record_id: 5, trigger_type: 4, payload: {} },
      { device_sn: "CAM1", record_id: 3, payload: { trigger_type: 2 } },
    ],
  }));
  assert.equal(await run(() => warm.latestTriggerType("CAM1")), 4);
});

test("latestTriggerType is undefined when the device has no records", async () => {
  const warm = setup(() => ({ data: [{ device_sn: "OTHER", record_id: 1, trigger_type: 4, payload: {} }] }));
  assert.equal(await run(() => warm.latestTriggerType("CAM1")), undefined);
});
