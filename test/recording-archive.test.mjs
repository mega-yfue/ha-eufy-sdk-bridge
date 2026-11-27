// RECORDINGS_DIR saves each HomeBase 3 recording to a folder, and RECORDINGS_OLD_DIR takes the old ones.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { clipName, createRecordingArchive } from "../src/recording-archive.mjs";
import { row, setup as fixture, files as all } from "./helpers/recordings-fixture.mjs";

const setup = (opts) => fixture({ ...opts, modules: [createRecordingArchive] });
/** Every file under `dir` but the archiver's queue. */
const files = (dir) => all(dir).filter((f) => f !== ".queue.json");
const tmp = (prefix = "rec-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("clipName: the UTC start, compact", () => {
  assert.equal(clipName(new Date("2026-01-01T18:00:41.000Z")), "20260101T180041Z.mp4");
});

test("archive: saves each finished recording once, as <serial>/<UTC start>.mp4", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  const rows = [row("CAM1", "20260101120000"), row("CAM2", "20260101121000")];
  const { ctx, calls } = setup({ rows, env: { RECORDINGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "rec-")) } });
  const dir = ctx.cfg.recordingsDir;
  await ctx.recordingArchiveSweep();
  assert.deepEqual(files(dir).sort(), ["CAM1/20260101T180000Z.mp4", "CAM2/20260101T181000Z.mp4"]);
  assert.equal(fs.readFileSync(path.join(dir, "CAM1/20260101T180000Z.mp4"), "utf8"), "MP4:CAM1:20260101120000");
  await ctx.recordingArchiveSweep();
  assert.equal(calls.download.length, 2); // already on disk: not downloaded again
});

test("archive: waits for a recording to finish, and fetches it after it leaves the station's list", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T18:00:30Z") });
  let rows = [row("CAM1", "20260101120000")]; // ends 18:00:59 UTC
  const { ctx, calls } = setup({
    rows: () => rows,
    env: { RECORDINGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "rec-")) },
  });
  await ctx.recordingArchiveSweep();
  assert.equal(calls.download.length, 0); // still being written
  rows = []; // the station's day rolled over
  t.mock.timers.setTime(new Date("2026-01-01T18:02:00Z").getTime());
  await ctx.recordingArchiveSweep();
  assert.deepEqual(files(ctx.cfg.recordingsDir), ["CAM1/20260101T180000Z.mp4"]);
});

test("archive: holds off while the camera streams, and gives up on a recording the station keeps answering no-data for", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  const rows = [row("CAM1", "20260101120000"), row("CAM2", "20260101121000")];
  const { ctx, calls } = setup({
    rows,
    streaming: ["CAM2"],
    env: { RECORDINGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "rec-")) },
    download: () => {
      throw Object.assign(new Error("gone"), { reason: "no-data" });
    },
  });
  await ctx.recordingArchiveSweep();
  assert.deepEqual(
    calls.download.map((c) => c.sn),
    ["CAM1"],
  );
  ctx.state.streaming.clear();
  for (let i = 0; i < 4; i++) await ctx.recordingArchiveSweep();
  assert.deepEqual(calls.download.map((c) => c.sn).sort(), ["CAM1", "CAM1", "CAM1", "CAM2", "CAM2", "CAM2"]); // no-data is tried three times (the SDK also says it for a station slow to answer); CAM2 waited its turn
  assert.deepEqual(files(ctx.cfg.recordingsDir), []);
});

test("archive: a failed download is retried on the next sweeps, then given up", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  const rows = [row("CAM1", "20260101120000")];
  const { ctx, calls } = setup({
    rows,
    env: { RECORDINGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "rec-")) },
    download: () => {
      throw Object.assign(new Error("transfer ended early"), { reason: "incomplete" });
    },
  });
  for (let i = 0; i < 5; i++) await ctx.recordingArchiveSweep();
  assert.equal(calls.download.length, 3); // given up on, though the station still lists it
  assert.deepEqual(files(ctx.cfg.recordingsDir), []); // no partial file left
});

test("archive: recordings older than RECORDINGS_OLD_DAYS move to RECORDINGS_OLD_DIR, and are not saved again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  const recent = tmp();
  const old = tmp("old-");
  const { ctx, calls } = setup({
    rows: [row("CAM1", "20260101120000")],
    env: { RECORDINGS_DIR: recent, RECORDINGS_OLD_DIR: old, RECORDINGS_OLD_DAYS: "30" },
  });
  await ctx.recordingArchiveSweep();
  assert.deepEqual(files(recent), ["CAM1/20260101T180000Z.mp4"]);
  t.mock.timers.setTime(new Date("2026-02-15T00:00:00Z").getTime());
  fs.writeFileSync(path.join(recent, "CAM1/20260201T000000Z.mp4"), "recent");
  await ctx.recordingArchiveSweep();
  assert.deepEqual(files(recent), ["CAM1/20260201T000000Z.mp4"]);
  assert.deepEqual(files(old), ["CAM1/20260101T180000Z.mp4"]);
  assert.equal(fs.readFileSync(path.join(old, "CAM1/20260101T180000Z.mp4"), "utf8"), "MP4:CAM1:20260101120000");
  assert.equal(calls.download.length, 1); // found in the old folder: not downloaded again
});

test("archive: the stations are found once, not by looking up every device on each sweep", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  const { ctx } = setup({ rows: [row("CAM1", "20260101120000")], env: { RECORDINGS_DIR: tmp() } });
  let lookups = 0;
  const getDevice = ctx.eufy.getDevice;
  ctx.eufy.getDevice = (sn) => (lookups++, getDevice(sn));
  await ctx.recordingArchiveSweep();
  const first = lookups;
  await ctx.recordingArchiveSweep();
  assert.equal(lookups, first); // nothing new to save: no device looked up
});

test("archive: a queued recording survives a restart after the station's day rolled over", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T18:00:30Z") });
  const dir = tmp();
  const before = setup({ rows: [row("CAM1", "20260101120000")], env: { RECORDINGS_DIR: dir } });
  await before.ctx.recordingArchiveSweep(); // still being written: queued
  assert.equal(before.calls.download.length, 0);
  t.mock.timers.setTime(new Date("2026-01-02T06:01:00Z").getTime()); // past the station's midnight
  const after = setup({ rows: [], env: { RECORDINGS_DIR: dir } });
  after.ctx.startRecordingArchive();
  clearInterval(after.ctx.state.timers.recordings);
  await after.ctx.recordingArchiveSweep();
  assert.deepEqual(files(dir), ["CAM1/20260101T180000Z.mp4"]);
});

test("archive: the list is read again just before the station's midnight", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-01-02T05:59:00Z") });
  const { ctx, calls } = setup({ rows: [row("CAM1", "20260101120000")], env: { RECORDINGS_DIR: tmp() } });
  ctx.startRecordingArchive(); // 23:59:00 station time (-0600); the next poll would come after midnight
  await ctx.recordingArchiveSweep();
  assert.equal(calls.table, 1);
  t.mock.timers.tick(30_000); // 23:59:30, 30 s before midnight
  await until(() => calls.table === 2);
  clearInterval(ctx.state.timers.recordings);
});

test("archive: nothing moves when RECORDINGS_OLD_DIR and RECORDINGS_DIR overlap", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  for (const sub of ["", "old"]) {
    const dir = tmp();
    const { ctx } = setup({
      rows: [row("CAM1", "20260101120000")],
      env: { RECORDINGS_DIR: dir, RECORDINGS_OLD_DIR: path.join(dir, sub), RECORDINGS_OLD_DAYS: "30" },
    });
    await ctx.recordingArchiveSweep();
    t.mock.timers.setTime(new Date("2026-02-15T00:00:00Z").getTime());
    await ctx.recordingArchiveSweep();
    assert.ok(files(dir).includes("CAM1/20260101T180000Z.mp4"), `old folder ${sub || "the same"}`);
    t.mock.timers.setTime(new Date("2026-01-01T19:00:00Z").getTime());
  }
});

/** Resolves after pending promise callbacks and I/O have run. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
/** Resolves once `cond()` holds; the clock is mocked, so the deadline is real time. */
const until = async (cond) => {
  const started = performance.now();
  while (!cond()) {
    if (performance.now() - started > 5000) throw new Error("timed out waiting");
    await new Promise((r) => setImmediate(r));
  }
};

test("archive: the read before midnight runs while downloads are still going", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-01-02T05:58:50Z") });
  let release;
  const { ctx, calls } = setup({
    rows: [row("CAM1", "20260101120000")],
    env: { RECORDINGS_DIR: tmp() },
    download: () => new Promise((r) => (release = () => r({ video: Buffer.from("V"), frames: 1 }))),
  });
  ctx.startRecordingArchive();
  await until(() => calls.download.length === 1); // the first sweep is stuck downloading
  t.mock.timers.tick(40_000); // 23:59:30 station time
  await until(() => calls.table === 2);
  release();
  await ctx.recordingArchiveSweep();
  clearInterval(ctx.state.timers.recordings);
});

test("archive: the read before midnight comes at the station's midnight, east of UTC too", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-01-01T22:59:00Z") });
  const { ctx, calls } = setup({
    rows: [row("CAM1", "20260101230000", { time_zone: "+0100", end_time: "2026-01-01 23:00:30" })],
    env: { RECORDINGS_DIR: tmp() },
  });
  ctx.startRecordingArchive(); // 23:59:00 station time
  await ctx.recordingArchiveSweep();
  t.mock.timers.tick(29_000);
  await settle();
  assert.equal(calls.table, 1);
  t.mock.timers.tick(1_000);
  await until(() => calls.table === 2);
  clearInterval(ctx.state.timers.recordings);
});

test("archive: a search for stations that hit an error is done again on the next sweep", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  const { ctx } = setup({ rows: [], env: { RECORDINGS_DIR: tmp() } });
  const getDevice = ctx.eufy.getDevice;
  let lookups = 0;
  ctx.eufy.getDevice = (sn) => (lookups++, sn === "CAM1" ? Promise.reject(new Error("cloud busy")) : getDevice(sn));
  await ctx.recordingArchiveSweep(); // CAM1's lookup failed; CAM2 found the station
  const first = lookups;
  await ctx.recordingArchiveSweep();
  assert.ok(lookups > first); // not kept: CAM1 might have been on another station
});

test("archive: a listed recording is written to the queue before any download", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  const { ctx, calls } = setup({
    rows: [row("CAM1", "20260101120000")],
    env: { RECORDINGS_DIR: tmp() },
    download: () => new Promise(() => {}), // the bridge is stopped mid-download
  });
  void ctx.recordingArchiveSweep();
  await until(() => calls.download.length === 1);
  const queue = JSON.parse(fs.readFileSync(path.join(ctx.cfg.recordingsDir, ".queue.json"), "utf8"));
  assert.deepEqual(
    queue.map((e) => e.rec.name),
    ["20260101120000"],
  );
});

test("archive: a local failure is retried without counting toward giving up", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  let full = true;
  const { ctx, calls } = setup({
    rows: [row("CAM1", "20260101120000")],
    env: { RECORDINGS_DIR: tmp() },
    muxClip: async (clip, out) => {
      if (full) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      fs.writeFileSync(out, "MP4");
    },
  });
  for (let i = 0; i < 5; i++) await ctx.recordingArchiveSweep();
  full = false;
  await ctx.recordingArchiveSweep();
  assert.equal(calls.download.length, 6);
  assert.deepEqual(files(ctx.cfg.recordingsDir), ["CAM1/20260101T180000Z.mp4"]);
});

test("archive: entries in the queue file that name no recording are dropped", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-01-02T07:00:00Z") });
  const dir = tmp();
  const good = {
    deviceSn: "CAM1",
    name: "20260101120000",
    cipherId: 0,
    start: "2026-01-01T18:00:00.000Z",
    end: "2026-01-01T18:00:59.000Z",
  };
  const queue = [{ rec: { start: "nope" } }, { rec: { ...good, deviceSn: "../x" } }, null, { rec: good, attempts: 0 }];
  fs.writeFileSync(path.join(dir, ".queue.json"), JSON.stringify(queue));
  const { ctx } = setup({ rows: [], env: { RECORDINGS_DIR: dir } });
  ctx.startRecordingArchive();
  await ctx.recordingArchiveSweep();
  clearInterval(ctx.state.timers.recordings);
  assert.deepEqual(files(dir), ["CAM1/20260101T180000Z.mp4"]);
});

test("archive: a recording still unsaved past the station's two weeks leaves the queue", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  const { ctx } = setup({ rows: [row("CAM1", "20260101120000")], streaming: ["CAM1"], env: { RECORDINGS_DIR: tmp() } });
  const queue = () => JSON.parse(fs.readFileSync(path.join(ctx.cfg.recordingsDir, ".queue.json"), "utf8"));
  await ctx.recordingArchiveSweep();
  assert.equal(queue().length, 1); // its camera is watched around the clock
  t.mock.timers.setTime(new Date("2026-01-14T19:00:00Z").getTime());
  await ctx.recordingArchiveSweep();
  assert.equal(queue().length, 1); // the station still holds it
  t.mock.timers.setTime(new Date("2026-01-15T19:00:00Z").getTime());
  await ctx.recordingArchiveSweep();
  assert.equal(queue().length, 0);
});

test("config: RECORDINGS_SETTLE_MS takes 0, and anything but a whole number falls back to 10 s", async () => {
  const settleOf = (v) => loadConfig({ RECORDINGS_SETTLE_MS: v }).cfg.recordingsSettleMs;
  assert.deepEqual([settleOf("0"), settleOf("2500"), settleOf("soon"), settleOf(undefined)], [0, 2500, 10_000, 10_000]);
});

test("archive: a search that finds no camera with stored recordings is kept too", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T19:00:00Z") });
  const { ctx } = setup({ rows: [], env: { RECORDINGS_DIR: tmp() } });
  let lookups = 0;
  ctx.eufy.getDevice = async () => (lookups++, { camera: () => ({}) }); // e.g. cameras on a HomeBase 2
  await ctx.recordingArchiveSweep();
  const first = lookups;
  await ctx.recordingArchiveSweep();
  assert.equal(lookups, first);
});

test("archive: queue writes from the read before midnight and a sweep do not collide", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-01-02T05:58:50Z") });
  const failures = [];
  const log = console.log;
  console.log = (...a) => (a.join(" ").includes("failed") ? failures.push(a.join(" ")) : undefined);
  try {
    for (let round = 0; round < 20; round++) {
      let release;
      let reads = 0;
      const rows = () => {
        if (++reads === 2) release?.(); // the download ends just as the read before midnight starts
        return [row("CAM1", "20260101120000"), row("CAM2", "20260101235900", { end_time: "2026-01-02 00:10:00" })];
      };
      const { ctx } = setup({
        rows,
        env: { RECORDINGS_DIR: tmp() },
        download: () => new Promise((r) => (release = () => r({ video: Buffer.from("V"), frames: 1 }))),
      });
      ctx.startRecordingArchive();
      await until(() => release);
      t.mock.timers.tick(40_000);
      await until(() => reads === 2);
      await ctx.recordingArchiveSweep();
      for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
      clearInterval(ctx.state.timers.recordings);
      const queue = JSON.parse(fs.readFileSync(path.join(ctx.cfg.recordingsDir, ".queue.json"), "utf8"));
      assert.deepEqual(
        queue.map((e) => e.rec.name),
        ["20260101235900"],
      ); // CAM2's recording, still being written, is in the file both writers wrote
      t.mock.timers.setTime(new Date("2026-01-02T05:58:50Z").getTime());
    }
  } finally {
    console.log = log;
  }
  assert.deepEqual(failures, []);
});
