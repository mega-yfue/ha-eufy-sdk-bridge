// audio-primer.mjs: the silence /audio answers with while a camera wakes.
//
// - The format comes from a real ADTS header (a T8200 sends AAC-LC, 16 kHz, stereo) and round-trips.
// - A silent frame declares that format, its own length, and is the same bytes ffmpeg decoded to zeros.
// - Silence is paced by the clock: the samples written match the time that passed.
// - The kept format survives on disk, and an unprimeable one is not loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adtsFormat,
  sameAdtsFormat,
  canPrime,
  silentAdtsFrame,
  startAudioPrimer,
  loadAudioFormat,
  saveAudioFormat,
  forgetAudioFormat,
  lastAudioFormatFile,
  describeAdtsFormat,
} from "../src/audio-primer.mjs";

// The first ADTS header a T8200 sent on 17 Nov 2026 (cold /audio), followed by two bytes of its frame.
const T8200_FRAME = Buffer.from("fff16080181ffc211a", "hex");
const T8200_FORMAT = { mpeg2: 0, profile: 1, rateIndex: 8, channels: 2 };

test("adtsFormat reads a T8200's header as AAC-LC, 16 kHz, stereo", () => {
  assert.deepEqual(adtsFormat(T8200_FRAME), T8200_FORMAT);
  assert.equal(describeAdtsFormat(T8200_FORMAT), "AAC-LC 16 kHz stereo");
  assert.equal(adtsFormat(Buffer.from("fff1aa", "hex")), null, "too short for a header");
  assert.equal(adtsFormat(Buffer.from("000000010000000000", "hex")), null, "no syncword");
  assert.equal(sameAdtsFormat(T8200_FORMAT, { ...T8200_FORMAT, channels: 1 }), false);
  assert.equal(sameAdtsFormat(null, T8200_FORMAT), false);
});

test("only mono or stereo AAC-LC at a known rate can be primed", () => {
  assert.equal(canPrime(T8200_FORMAT), true);
  assert.equal(canPrime({ ...T8200_FORMAT, channels: 1 }), true);
  assert.equal(canPrime({ ...T8200_FORMAT, channels: 6 }), false);
  assert.equal(canPrime({ ...T8200_FORMAT, profile: 0 }), false, "AAC Main");
  assert.equal(canPrime({ ...T8200_FORMAT, rateIndex: 13 }), false, "reserved rate index");
  assert.equal(canPrime(null), false);
});

test("a silent frame declares the camera's format and its own length", () => {
  for (const fmt of [T8200_FORMAT, { ...T8200_FORMAT, channels: 1 }, { ...T8200_FORMAT, rateIndex: 3 }]) {
    const frame = silentAdtsFrame(fmt);
    assert.deepEqual(adtsFormat(frame), fmt);
    const declared = ((frame[3] & 3) << 11) | (frame[4] << 3) | (frame[5] >> 5);
    assert.equal(declared, frame.length);
    assert.equal(frame[1] & 1, 1, "no CRC");
  }
  // The bytes checked with ffmpeg 7: 50 frames each decode to zeros with no error, and 40 stereo frames
  // followed by a T8200's live audio decode as one stream.
  assert.equal(silentAdtsFrame(T8200_FORMAT).toString("hex"), "fff1608001dffc2000000000000e");
  assert.equal(silentAdtsFrame({ ...T8200_FORMAT, channels: 1 }).toString("hex"), "fff16040017ffc00000007");
});

/** A response stand-in that records what is written. */
function fakeRes() {
  const res = { writes: [], destroyed: false, writableEnded: false, listeners: {} };
  res.write = (b) => void res.writes.push(b);
  res.once = (ev, fn) => void (res.listeners[ev] = fn);
  return res;
}

const tick = () => new Promise((r) => setTimeout(r, 60)); // longer than the primer's 32 ms timer at 16 kHz

test("silence is written at the camera's frame rate, by the clock", async () => {
  let clock = 1_000_000;
  const res = fakeRes();
  const primer = startAudioPrimer(res, T8200_FORMAT, { now: () => clock });
  try {
    assert.equal(primer.frames, 1, "one frame at once");
    clock += 1000; // a timer that fires late still catches up: 1 s at 16 kHz is 15.6 frames of 1024 samples
    await tick();
    assert.equal(primer.frames, 16, "frames 0..15 are due after 1000 ms (64 ms each)");
    assert.equal(res.writes.length, 16);
    primer.stop();
    clock += 1000;
    await tick();
    assert.equal(primer.frames, 16, "nothing after stop()");
  } finally {
    primer.stop();
  }
});

test("the primer stops when the response closes", async () => {
  let clock = 0;
  const res = fakeRes();
  const primer = startAudioPrimer(res, T8200_FORMAT, { now: () => clock });
  res.listeners.close();
  clock += 5000;
  await tick();
  assert.equal(primer.frames, 1);
});

test("the kept format is saved, loaded and forgotten", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-primer-"));
  try {
    assert.equal(await loadAudioFormat(dir, "CAM1"), null, "nothing kept yet");
    await saveAudioFormat(dir, "CAM1", T8200_FORMAT);
    assert.deepEqual(await loadAudioFormat(dir, "CAM1"), T8200_FORMAT);
    await saveAudioFormat(dir, "CAM2", { ...T8200_FORMAT, channels: 6 });
    assert.equal(await loadAudioFormat(dir, "CAM2"), null, "a format we cannot build silence for is not used");
    fs.writeFileSync(lastAudioFormatFile(dir, "CAM3"), "not json");
    assert.equal(await loadAudioFormat(dir, "CAM3"), null);
    await forgetAudioFormat(dir, "CAM1");
    assert.equal(await loadAudioFormat(dir, "CAM1"), null);
    assert.equal(await loadAudioFormat(undefined, "CAM1"), null, "no data directory");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
