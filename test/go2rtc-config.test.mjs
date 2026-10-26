// The generated go2rtc config is what every consumer ends up pulling, so its source line carries the
// flags that decide whether a stream is usable. `#async` re-stamps frames from the wall clock: without
// it the eufy feed's own timestamps (dts 0, then a jump) make Home Assistant abort a picture that is
// already flowing — "Timestamp discontinuity detected: last dts = 0, dts = 4219155056".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

const cams = [
  { sn: "CAM1", stream: "/stream/CAM1" },
  { sn: "CAM2", stream: "/stream/CAM2" },
  { sn: "SENSOR1" }, // no stream path → not a camera, must not appear
];

async function generate(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go2rtc-"));
  const file = path.join(dir, "go2rtc.yaml");
  const sns = await writeGo2rtcConfig({ go2rtcConfig: file, selfHost: "127.0.0.1", port: 3000, ...extra }, cams);
  return { yaml: fs.readFileSync(file, "utf8"), sns };
}

test("every camera stream is generated with #async", async () => {
  const { yaml, sns } = await generate();
  assert.deepEqual(sns, ["CAM1", "CAM2"]);
  assert.match(yaml, /CAM1: ffmpeg:http:\/\/127\.0\.0\.1:3000\/stream\/CAM1#video=copy#async/);
});

// An H.265 camera plays nowhere that lacks an H.265 decoder (a Pi's Chromium, WebRTC in desktop Chrome),
// so a listed camera is converted to H.264, scaled, with an even height; the rest are still copied.
test("a camera listed for transcoding is converted to H.264 at the set width", async () => {
  const { yaml } = await generate({ transcodeH264: ["CAM2"], transcodeWidth: 1280 });
  assert.match(yaml, /CAM2: ffmpeg:http:\/\/127\.0\.0\.1:3000\/stream\/CAM2#video=h264#width=1280#height=-2#async/);
  assert.match(yaml, /CAM1: ffmpeg:http:\/\/127\.0\.0\.1:3000\/stream\/CAM1#video=copy#async/);
});

test("a camera listed for transcoding keeps its own size when no width is set", async () => {
  const { yaml } = await generate({ transcodeH264: ["CAM2"] });
  assert.match(yaml, /CAM2: ffmpeg:http:\/\/127\.0\.0\.1:3000\/stream\/CAM2#video=h264#async/);
});

test("a device without a stream path is left out", async () => {
  const { yaml } = await generate();
  assert.ok(!yaml.includes("SENSOR1"), "non-camera devices must not become go2rtc streams");
});
