// A HomeBase 3 can stop answering the direct `history_record_info` read on a session that still reports
// itself connected, freezing every camera's "Last event". After three silent reads in a row the bridge
// closes and reopens that station's P2P session; a station that never answered, or one whose camera is
// streaming, is left alone.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWarmup } from "../src/warmup.mjs";

/** A station session whose direct read (10000) answers `rows()` while it returns rows, else nothing. */
function fakeStation(rows) {
  const s = new EventEmitter();
  s.isConnected = true;
  s.closed = 0;
  s.close = async () => {
    s.closed += 1;
  };
  s.queryDatabase = (_table, opts) => {
    const data = opts.innerCmd === 10000 ? rows() : undefined;
    if (data) setTimeout(() => s.emit("dbChunk", { text: JSON.stringify({ data }) }), 0);
  };
  s.requestImage = (file) => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(file), Buffer.alloc(300, 0x41)]);
    setTimeout(() => s.emit("image", { file, data: jpeg }), 0);
  };
  return s;
}

function setup(station, { streaming = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silent-station-"));
  const reconnects = [];
  const warm = createWarmup({
    eventImageDir: dir,
    eventLog: () => {},
    broadcast: () => {},
    state: { faceNames: new Map(), streaming: new Set(streaming) },
    eufy: {
      getP2pSessions: () => new Map([["HB3", station]]),
      getDevices: async () => [{ sn: "HB3", p2pDid: "EUPREMB-012345-ABCDE" }],
      connectStation: async (sn) => reconnects.push(sn),
    },
  });
  return { warm, reconnects };
}

/** Run `fn` under mocked timers, ticking them until it settles (a silent read polls for ~14 s). */
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

const quiet = (fn) => {
  const original = console.error;
  console.error = () => {};
  return fn().finally(() => (console.error = original));
};

test("a station that answered and then goes silent three times in a row is reopened", async () => {
  let rows = [{ device_sn: "CAM1", record_id: 1, crop_hb3_path: "/mnt/a.jpg" }];
  const station = fakeStation(() => rows);
  const { warm, reconnects } = setup(station);

  await run(() => warm.refreshLastEventImageFor("CAM1"));
  rows = undefined;
  await quiet(async () => {
    for (let i = 0; i < 2; i++) await run(() => warm.refreshLastEventImageFor("CAM1"));
    assert.equal(station.closed, 0, "two silent reads are not enough");
    await run(() => warm.refreshLastEventImageFor("CAM1"));
  });
  assert.equal(station.closed, 1);
  assert.deepEqual(reconnects, ["HB3"]);
});

test("a station that has never answered the direct read is not reopened", async () => {
  const station = fakeStation(() => undefined);
  const { warm, reconnects } = setup(station);

  await quiet(async () => {
    for (let i = 0; i < 3; i++) await run(() => warm.refreshLastEventImageFor("CAM1"));
  });
  assert.equal(station.closed, 0);
  assert.deepEqual(reconnects, []);
});

test("silent reads while a camera streams are not counted", async () => {
  let rows = [{ device_sn: "CAM1", record_id: 1, crop_hb3_path: "/mnt/a.jpg" }];
  const station = fakeStation(() => rows);
  const { warm, reconnects } = setup(station, { streaming: ["CAM1"] });

  await run(() => warm.refreshLastEventImageFor("CAM1"));
  rows = undefined;
  await quiet(async () => {
    for (let i = 0; i < 3; i++) await run(() => warm.refreshLastEventImageFor("CAM1"));
  });
  assert.equal(station.closed, 0);
  assert.deepEqual(reconnects, []);
});
