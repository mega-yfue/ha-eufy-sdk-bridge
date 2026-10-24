// The generated go2rtc config is what every consumer ends up pulling, so its source lines carry the
// flags that decide whether a stream is usable. `#async` re-stamps frames from the wall clock: without
// it the eufy feed's own timestamps (dts 0, then a jump) make Home Assistant abort a picture that is
// already flowing — "Timestamp discontinuity detected: last dts = 0, dts = 4219155056". Audio is read by
// go2rtc itself: `ffmpeg:…#audio=copy` cannot write raw ADTS to RTSP ("AAC with no global headers"), and
// a failed audio source takes the whole audio track with it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

const cams = [
  { sn: "CAM1", stream: "/stream/CAM1" },
  { sn: "SENSOR1" }, // no stream path → not a camera, must not appear
];

async function generate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go2rtc-"));
  const file = path.join(dir, "go2rtc.yaml");
  const sns = await writeGo2rtcConfig({ go2rtcConfig: file, selfHost: "127.0.0.1", port: 3000 }, cams);
  return { yaml: fs.readFileSync(file, "utf8"), sns };
}

test("every camera stream is generated with #async", async () => {
  const { yaml, sns } = await generate();
  assert.deepEqual(sns, ["CAM1"]);
  assert.match(yaml, /\n {2}CAM1:\n {4}- ffmpeg:http:\/\/127\.0\.0\.1:3000\/stream\/CAM1#video=copy#async\n/);
});

test("each camera's audio is read by go2rtc itself, with an Opus loopback for WebRTC", async () => {
  const { yaml } = await generate();
  assert.match(yaml, /#async\n {4}- http:\/\/127\.0\.0\.1:3000\/audio\/CAM1\n {4}- ffmpeg:CAM1#audio=opus\n/);
  assert.ok(!yaml.includes("audio=copy"), "an ffmpeg copy of raw ADTS fails on RTSP and loses the audio track");
});

test("a device without a stream path is left out", async () => {
  const { yaml } = await generate();
  assert.ok(!yaml.includes("SENSOR1"), "non-camera devices must not become go2rtc streams");
});
