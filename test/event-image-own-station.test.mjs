// A "Last event" refresh reads the device's own station first. A station that never answers the history read
// (a HomeBase 2, a standalone camera) costs a full ~14 s wait per refresh, and every refresh runs under the one
// DB lock, so reading every connected station in map order kept the lock busy and delayed every other camera.
// The records below have the shape a HomeBase 3 (T8030) returns: the cover is the event folder of
// `storage_path` plus `thumb_path`, and `record_id` is the day plus a running count.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWarmup } from "../src/warmup.mjs";

const record = (deviceSn, stationSn, n) => ({
  device_sn: deviceSn,
  station_sn: stationSn,
  record_id: Number(`20261112${String(n).padStart(5, "0")}`),
  start_time: `2026-11-12 16:00:${String(n).padStart(2, "0")}`,
  storage_path: `/zx/hdd_data0/Camera04/202611/2026111216005${n}/2026111216005${n}.zxvideo`,
  thumb_path: "snapshort.jpg",
  trigger_type: 4,
});

/** A station session that answers the direct read (10000) with `rows()` when it returns rows, else stays silent. */
function fakeStation(rows) {
  const s = new EventEmitter();
  s.isConnected = true;
  s.reads = 0; // direct reads sent; a read with no answer is sent twice (the resend at 1.5 s)
  s.close = async () => {};
  s.queryDatabase = (_table, opts) => {
    if (opts.innerCmd === 10000) s.reads += 1;
    const data = opts.innerCmd === 10000 ? rows() : undefined;
    if (data) setTimeout(() => s.emit("dbChunk", { text: JSON.stringify({ data }) }), 0);
  };
  s.requestImage = (file) => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(file), Buffer.alloc(300, 0x41)]);
    setTimeout(() => s.emit("image", { file, data: jpeg }), 0);
  };
  return s;
}

/** Map order puts the HomeBase 2 first, as `getP2pSessions()` did on the account this was measured on. */
function setup(stations, devices) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "own-station-"));
  const log = [];
  const warm = createWarmup({
    eventImageDir: dir,
    eventLog: (line) => log.push(line),
    broadcast: () => {},
    state: { faceNames: new Map(), streaming: new Set() },
    eufy: {
      getP2pSessions: () => new Map(Object.entries(stations)),
      getDevices: async () => devices,
      connectStation: async () => {},
    },
  });
  return { warm, log };
}

/** Run `fn` under mocked timers, ticking them until it settles (a silent read polls for ~14 s). */
async function run(fn) {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let done = false;
    let ticks = 0;
    const p = fn().finally(() => (done = true));
    while (!done) {
      mock.timers.tick(200);
      ticks += 1;
      await new Promise((r) => setImmediate(r));
    }
    return { result: await p, ms: ticks * 200 };
  } finally {
    mock.timers.reset();
  }
}

const DEVICES = [
  { sn: "HB2", stationSn: "HB2" },
  { sn: "HB3", stationSn: "HB3" },
  { sn: "CAM1", stationSn: "HB3" },
  { sn: "CAM2", stationSn: "HB3" },
  { sn: "FLOOD", stationSn: "FLOOD" },
];

test("a camera on a HomeBase 3 is read from that station only, without waiting on silent ones", async () => {
  const hb2 = fakeStation(() => undefined);
  const hb3 = fakeStation(() => [record("CAM1", "HB3", 41), record("CAM2", "HB3", 40)]);
  const flood = fakeStation(() => undefined);
  const { warm } = setup({ HB2: hb2, HB3: hb3, FLOOD: flood }, DEVICES);

  const { result, ms } = await run(() => warm.refreshLastEventImageFor("CAM1"));

  assert.equal(result, true, "the cover was fetched and persisted");
  assert.equal(hb3.reads, 1);
  assert.equal(hb2.reads, 0, "the HomeBase 2 is not asked for a camera that is not on it");
  assert.equal(flood.reads, 0);
  assert.ok(ms < 5000, `finished in ${ms} ms instead of waiting out a silent station`);
});

test("when its own station answers without a record for it, the other stations are not read", async () => {
  // After local midnight a HomeBase 3 returns only the new day's rows, so a camera with no event yet today
  // is simply absent from an otherwise normal answer.
  const hb2 = fakeStation(() => undefined);
  const hb3 = fakeStation(() => [record("CAM2", "HB3", 3)]);
  const flood = fakeStation(() => undefined);
  const { warm, log } = setup({ HB2: hb2, HB3: hb3, FLOOD: flood }, DEVICES);

  const { result } = await run(() => warm.refreshLastEventImageFor("CAM1"));

  assert.equal(result, false);
  assert.equal(hb3.reads, 1);
  assert.equal(hb2.reads, 0);
  assert.equal(flood.reads, 0);
  assert.ok(log.includes("local refresh: CAM1 — no local cover found on its station HB3"));
});

test("when its own station is silent, the other stations are still read as before", async () => {
  const hb3 = fakeStation(() => undefined);
  const other = fakeStation(() => [record("CAM1", "HB3B", 7)]);
  const { warm, log } = setup({ HB3: hb3, HB3B: other }, DEVICES);

  const { result } = await run(() => warm.refreshLastEventImageFor("CAM1"));

  assert.equal(result, true, "a cover found elsewhere is still used");
  assert.ok(hb3.reads > 0);
  assert.ok(other.reads > 0);
  assert.ok(log.includes("history query: no records parsed (raw 0B received; latest-info unanswered too) from HB3"));
});

test("a device missing from the device list keeps the old order over every station", async () => {
  const hb2 = fakeStation(() => undefined);
  const hb3 = fakeStation(() => [record("CAM9", "HB3", 1)]);
  const { warm } = setup({ HB2: hb2, HB3: hb3 }, DEVICES);

  const { result } = await run(() => warm.refreshLastEventImageFor("CAM9"));

  assert.equal(result, true);
  assert.ok(hb2.reads > 0, "with no known station every connected station is read, in map order");
  assert.ok(hb3.reads > 0);
});

test("a silent read names the station it was sent to", async () => {
  const flood = fakeStation(() => undefined);
  const hb3 = fakeStation(() => [record("CAM1", "HB3", 1)]);
  const { warm, log } = setup({ FLOOD: flood, HB3: hb3 }, DEVICES);

  await run(() => warm.refreshLastEventImageFor("FLOOD"));

  assert.ok(
    log.some((l) => l.startsWith("history query: no records parsed (raw 0B received") && l.endsWith(" from FLOOD")),
    log.join("\n"),
  );
});
