// A HomeBase 2 sends nothing back to the direct `history_record_info` read (10000), so its cameras
// never got a local "Last event" cover. Such a station is asked the latest-info query (10013, mChannel 0)
// instead, and its crop is persisted only when the path it names changes.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv } from "node:crypto";
import { getImageKey } from "@mega-yfue/eufy-sdk";
import { createWarmup } from "../src/warmup.mjs";

const P2P_DID = "EUPREMB-012345-ABCDE";
/** A JPEG inside the `eufysecurity:` wrapper a HomeBase 2 answers a stored-image request with. */
function wrapV1(jpeg, serial = "T8010P0000000001", code = "0123456789") {
  const key = Buffer.from(getImageKey(serial, P2P_DID, code), "utf-8").subarray(0, 16);
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  const head = Buffer.concat([c.update(jpeg.subarray(0, 256)), c.final()]);
  return Buffer.concat([Buffer.from(`eufysecurity:${serial}:${code}:`, "latin1"), head, jpeg.subarray(256)]);
}

/** A station session: `direct` answers the 10000 read (rows), `latest` answers 10013 (entries). */
function fakeStation({ direct, latest }) {
  const s = new EventEmitter();
  s.isConnected = true;
  s.asked = [];
  s.images = [];
  s.queryDatabase = (_table, opts) => {
    s.asked.push(`${opts.innerCmd}@${opts.channel ?? 255}`);
    const reply = opts.innerCmd === 10000 ? direct?.() : opts.innerCmd === 10013 ? latest?.() : undefined;
    if (reply) setTimeout(() => s.emit("dbChunk", { text: JSON.stringify(reply) }), 0);
  };
  s.dropImages = 0;
  s.wrapImages = false;
  s.requestImage = (file) => {
    s.images.push(file);
    if (s.dropImages-- > 0) return;
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(file), Buffer.alloc(300, 0x41)]);
    const data = s.rawImage ?? (s.wrapImages ? wrapV1(jpeg) : jpeg);
    setTimeout(() => s.emit("image", { file, data }), 0);
  };
  return s;
}

function setup(station) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "latest-info-"));
  const log = [];
  const warm = createWarmup({
    eventImageDir: dir,
    eventLog: (m) => log.push(m),
    broadcast: () => {},
    state: { faceNames: new Map() },
    eufy: {
      getP2pSessions: () => new Map([["HB2", station]]),
      getDevices: async () => [{ sn: "HB2", p2pDid: P2P_DID }],
    },
  });
  return { warm, log, file: path.join(dir, "last-event-CAM1.jpg") };
}

const latestFor = (crop, count) => () => ({
  data: [
    { device_sn: "HB2", payload: { event_count: 3, crop_hb3_path: "", crop_cloud_path: "" } },
    { device_sn: "CAM1", payload: { event_count: count, crop_hb3_path: crop, crop_cloud_path: "" } },
  ],
  cmd: 10013,
  mIntRet: 0,
});

/** Run `fn` under mocked timers, ticking them until it settles (the reads poll for up to ~14 s). */
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

test("a station silent on the direct read is asked latest-info, and a crop is taken only when its path changes", async () => {
  let latest = latestFor("/media/mmcblk0p1/video/20261013100000_c01.jpg", 41);
  const station = fakeStation({ latest: () => latest() });
  const { warm, log, file } = setup(station);

  assert.equal(await run(() => warm.refreshLastEventImageFor("CAM1")), true);
  assert.deepEqual(station.asked, ["10000@255", "10000@255", "10013@0"]);
  assert.equal(
    fs
      .readFileSync(file)
      .subarray(2, 2 + "/media/mmcblk0p1/video/20261013100000_c01.jpg".length)
      .toString(),
    "/media/mmcblk0p1/video/20261013100000_c01.jpg",
  );
  assert.ok(log.includes("latest-info: CAM1 event_count=41 crop=20261013100000_c01.jpg (first seen, taken)"));

  assert.equal(await run(() => warm.refreshLastEventImageFor("CAM1")), false);
  assert.equal(station.images.length, 1, "an unchanged path is not fetched again");
  assert.ok(log.includes("latest-info: CAM1 event_count=41 crop=20261013100000_c01.jpg (unchanged)"));

  latest = latestFor("/media/mmcblk0p1/video/20261013110000_c01.jpg", 42);
  assert.equal(await run(() => warm.refreshLastEventImageFor("CAM1")), true);
  assert.equal(
    fs
      .readFileSync(file)
      .subarray(2, 2 + "/media/mmcblk0p1/video/20261013110000_c01.jpg".length)
      .toString(),
    "/media/mmcblk0p1/video/20261013110000_c01.jpg",
  );
  assert.ok(log.includes("latest-info: CAM1 event_count=42 crop=20261013110000_c01.jpg (advanced, taken)"));
});

test("a taken crop whose image fetch failed is taken again on the next refresh", async () => {
  const station = fakeStation({ latest: latestFor("/media/mmcblk0p1/video/20261013100000_c01.jpg", 41) });
  station.dropImages = 1;
  const { warm, file } = setup(station);

  assert.equal(await run(() => warm.refreshLastEventImageFor("CAM1")), false);
  assert.equal(await run(() => warm.refreshLastEventImageFor("CAM1")), true);
  assert.equal(station.images.length, 2);
  assert.ok(fs.existsSync(file));
});

test("the first latest-info crop does not replace an image already on disk", async () => {
  const station = fakeStation({ latest: latestFor("/media/mmcblk0p1/video/20251122113019_c00.jpg", 1070) });
  const { warm, file } = setup(station);
  fs.writeFileSync(file, "newer push thumbnail");

  assert.equal(await run(() => warm.refreshLastEventImageFor("CAM1")), false);
  assert.equal(station.images.length, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "newer push thumbnail");
});

test("a station that has answered the direct read is never asked latest-info", async () => {
  let rows = [{ device_sn: "CAM1", record_id: 7, crop_hb3_path: "/mnt/a.jpg" }];
  const station = fakeStation({ direct: () => rows && { data: rows }, latest: latestFor("/mnt/b.jpg", 1) });
  const { warm } = setup(station);

  await run(() => warm.refreshLastEventImageFor("CAM1"));
  rows = undefined; // the direct read drops once
  await run(() => warm.refreshLastEventImageFor("CAM1"));
  assert.ok(!station.asked.includes("10013@0"));
});

test("a station silent on both forms stops being asked latest-info after three tries", async () => {
  const station = fakeStation({});
  const { warm, log } = setup(station);

  for (let i = 0; i < 5; i++) await run(() => warm.refreshLastEventImageFor("CAM1"));
  assert.equal(station.asked.filter((a) => a === "10013@0").length, 3);
  assert.ok(log.includes("history query: no records parsed (raw 0B received; latest-info unanswered too)"));
});

test("a station that has answered latest-info is still asked after it falls silent", async () => {
  let latest = latestFor("/media/mmcblk0p1/video/20261013100000_c01.jpg", 41);
  const station = fakeStation({ latest: () => latest?.() });
  const { warm, log } = setup(station);

  assert.equal(await run(() => warm.refreshLastEventImageFor("CAM1")), true);
  latest = undefined; // three misses in a row, and more
  for (let i = 0; i < 5; i++) await run(() => warm.refreshLastEventImageFor("CAM1"));
  assert.equal(station.asked.filter((a) => a === "10013@0").length, 6);

  latest = latestFor("/media/mmcblk0p1/video/20261013110000_c01.jpg", 42);
  assert.equal(await run(() => warm.refreshLastEventImageFor("CAM1")), true);
  assert.ok(log.includes("latest-info: CAM1 event_count=42 crop=20261013110000_c01.jpg (advanced, taken)"));
});

test("a cover answered inside the eufysecurity: wrapper is unwrapped and persisted as a JPEG", async () => {
  const path = "/media/mmcblk0p1/video/20261013100000_c01.jpg";
  const station = fakeStation({ latest: latestFor(path, 41) });
  station.wrapImages = true;
  const { warm, file } = setup(station);

  assert.equal(await run(() => warm.refreshLastEventImageFor("CAM1")), true);
  const written = fs.readFileSync(file);
  assert.deepEqual([...written.subarray(0, 2)], [0xff, 0xd8]);
  assert.equal(written.subarray(2, 2 + path.length).toString(), path);
});

test("a cover reply the SDK cannot decode is logged with its wrapper tag, never its serial", async () => {
  const crop = "/media/mmcblk0p1/video/20261016131534_c00.jpg";
  const station = fakeStation({ latest: latestFor(crop, 634) });
  station.rawImage = Buffer.concat([
    Buffer.from("v8_eufysecurity:T8010P0000000001:0123456789:", "latin1"),
    Buffer.alloc(300, 7),
  ]);
  const { warm, log, file } = setup(station);

  assert.equal(await run(() => warm.refreshLastEventImageFor("CAM1")), false);
  assert.ok(!fs.existsSync(file));
  const line = log.find((m) => m.startsWith("cover reply for 20261016131534_c00.jpg"));
  assert.equal(
    line,
    `cover reply for 20261016131534_c00.jpg is not a JPEG after decoding (${station.rawImage.length}B, starts "v8_eufysecurity:")`,
  );
  assert.ok(!line.includes("T8010P0000000001"));
});
