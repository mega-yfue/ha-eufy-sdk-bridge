// A battery camera's still should show what was last SEEN, not only the last event: the last keyframe of a
// watched stream is kept and written as last-live-<sn>.jpg when the stream ends — never by waking the camera.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { keyframeCodec, createLiveStillTap } from "../src/live-still.mjs";

const SC = [0x00, 0x00, 0x00, 0x01]; // Annex-B start code
const au = (...nals) => Buffer.from(nals.flatMap((n) => [...SC, ...n]));

// H.264: SPS (0x67), PPS (0x68), IDR slice (0x65); a delta frame is a non-IDR slice (0x41).
const H264_KEY = au([0x67, 0x64, 0x00, 0x1f], [0x68, 0xee, 0x3c], [0x65, 0x88, 0x84]);
const H264_DELTA = au([0x41, 0x9a, 0x02]);
// H.265: VPS (0x40 0x01), SPS (0x42 0x01), PPS (0x44 0x01), IDR_W_RADL (0x26 0x01); delta TRAIL_R (0x02 0x01).
const HEVC_KEY = au([0x40, 0x01, 0x0c], [0x42, 0x01, 0x01], [0x44, 0x01, 0xc1], [0x26, 0x01, 0xaf]);
const HEVC_DELTA = au([0x02, 0x01, 0xd0]);

test("keyframeCodec recognises an H.264 keyframe by its SPS", () => {
  assert.equal(keyframeCodec(H264_KEY), "h264");
});

test("keyframeCodec recognises an H.265 keyframe by its VPS", () => {
  assert.equal(keyframeCodec(HEVC_KEY), "hevc");
});

test("keyframeCodec does not mistake an H.264 delta slice for an H.265 VPS", () => {
  // 0x41 is the commonest H.264 slice header and also parses as H.265 type 32; with 0x01 after it, only the
  // missing H.265 SPS tells the two apart.
  assert.equal(keyframeCodec(au([0x41, 0x01, 0x9a])), null);
});

test("keyframeCodec ignores delta frames of either codec", () => {
  assert.equal(keyframeCodec(H264_DELTA), null);
  assert.equal(keyframeCodec(HEVC_DELTA), null);
  assert.equal(keyframeCodec(Buffer.from("not video")), null);
});

function tapInto(dir, extra = {}) {
  const converted = [];
  const tap = createLiveStillTap({
    sn: "CAM1",
    dir,
    ...extra,
    toJpeg: async (frame, codec) => {
      converted.push({ frame, codec });
      return Buffer.from(`JPEG:${codec}`);
    },
  });
  return { tap, converted };
}

test("the tap keeps the LATEST keyframe and writes it as last-live-<sn>.jpg on flush", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  const { tap, converted } = tapInto(dir);
  tap.onChunk(HEVC_KEY);
  tap.onChunk(HEVC_DELTA);
  tap.onChunk(H264_KEY); // a later keyframe replaces the earlier one
  tap.onChunk(H264_DELTA);
  assert.equal(await tap.flush(), true);
  assert.equal(converted.length, 1);
  assert.equal(converted[0].codec, "h264");
  assert.deepEqual(converted[0].frame, H264_KEY);
  assert.equal(fs.readFileSync(path.join(dir, "last-live-CAM1.jpg"), "utf8"), "JPEG:h264");
});

test("a stream that never showed a keyframe writes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  const { tap, converted } = tapInto(dir);
  tap.onChunk(H264_DELTA);
  assert.equal(await tap.flush(), false);
  assert.equal(converted.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "last-live-CAM1.jpg")), false);
});

test("flush converts once, however often the route's cleanup fires", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  const { tap, converted } = tapInto(dir);
  tap.onChunk(H264_KEY);
  await Promise.all([tap.flush(), tap.flush(), tap.flush()]);
  assert.equal(converted.length, 1);
});

test("a failed conversion is reported, not thrown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  const logs = [];
  const tap = createLiveStillTap({
    sn: "CAM1",
    dir,
    log: (m) => logs.push(m),
    toJpeg: async () => {
      throw new Error("ffmpeg exited 1");
    },
  });
  tap.onChunk(H264_KEY);
  assert.equal(await tap.flush(), false);
  assert.match(logs[0], /could not keep the live picture: ffmpeg exited 1/);
});

test("the picture is saved DURING the stream: after firstAfterMs, then every everyMs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  let clock = 0;
  const { tap, converted } = tapInto(dir, { firstAfterMs: 5_000, everyMs: 30_000, now: () => clock });
  tap.onChunk(H264_KEY); // t=0: the first frames after a wake are often mis-exposed — not yet
  await tap.idle();
  assert.equal(converted.length, 0);
  clock = 6_000;
  tap.onChunk(H264_KEY); // past firstAfterMs → saved while the stream still runs
  await tap.idle();
  assert.equal(converted.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "last-live-CAM1.jpg")), true);
  clock = 20_000;
  tap.onChunk(H264_KEY); // only 14s since the last save → not yet
  await tap.idle();
  assert.equal(converted.length, 1);
  clock = 37_000;
  tap.onChunk(H264_KEY); // 31s since the last save → saved again
  await tap.idle();
  assert.equal(converted.length, 2);
});

test("flush saves a newer keyframe at the end, but not one that was already saved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  let clock = 0;
  const { tap, converted } = tapInto(dir, { firstAfterMs: 5_000, everyMs: 30_000, now: () => clock });
  tap.onChunk(H264_KEY);
  clock = 6_000;
  tap.onChunk(HEVC_KEY); // saved during the stream
  await tap.idle();
  assert.equal(converted.length, 1);
  clock = 9_000;
  tap.onChunk(H264_KEY); // newer, not yet saved
  assert.equal(await tap.flush(), true);
  assert.equal(converted.length, 2);
  assert.equal(converted[1].codec, "h264"); // the end shows the last moment seen
});

test("flush has nothing to add when the last keyframe was already saved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  let clock = 0;
  const { tap, converted } = tapInto(dir, { firstAfterMs: 0, now: () => clock });
  tap.onChunk(H264_KEY); // firstAfterMs 0 → saved at once
  await tap.idle();
  assert.equal(await tap.flush(), false);
  assert.equal(converted.length, 1);
});

test("conversions never overlap: a keyframe due while one is running is skipped, not stacked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  let clock = 0;
  let release;
  let running = 0;
  let maxRunning = 0;
  const tap = createLiveStillTap({
    sn: "CAM1",
    dir,
    firstAfterMs: 0,
    everyMs: 0,
    now: () => clock,
    toJpeg: async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => {
        release = r;
      });
      running -= 1;
      return Buffer.from("J");
    },
  });
  tap.onChunk(H264_KEY); // starts a slow conversion
  clock = 1;
  tap.onChunk(H264_KEY); // due too, but one is running — skipped, not stacked
  release();
  await tap.idle();
  assert.equal(maxRunning, 1);
});

test("onSaved fires after the picture is written (Last screen refresh), and a failing listener is harmless", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  let saved = 0;
  const { tap } = tapInto(dir, {
    onSaved: () => {
      saved += 1;
      throw new Error("listener broke");
    },
  });
  tap.onChunk(H264_KEY);
  assert.equal(await tap.flush(), true);
  assert.equal(saved, 1);
  assert.ok(fs.existsSync(path.join(dir, "last-live-CAM1.jpg")));
});
