// The generated go2rtc config is what every consumer ends up pulling, so its source line carries the
// flags that decide whether a stream is usable. `#async` re-stamps frames from the wall clock: without
// it the eufy feed's own timestamps (dts 0, then a jump) make Home Assistant abort a picture that is
// already flowing — "Timestamp discontinuity detected: last dts = 0, dts = 4219155056".
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { writeGo2rtcConfig } from "../go2rtc-config.mjs";
import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createWsServer } from "../src/ws-server.mjs";

const cams = [
  { sn: "CAM1", stream: "/stream/CAM1" },
  { sn: "SENSOR1" }, // no stream path → not a camera, must not appear
];

async function generate(extra = {}, devices = cams) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go2rtc-"));
  const file = path.join(dir, "go2rtc.yaml");
  const sns = await writeGo2rtcConfig({ selfHost: "127.0.0.1", port: 3000, ...extra, go2rtcConfig: file }, devices);
  return { yaml: fs.readFileSync(file, "utf8"), sns };
}

test("every camera stream is generated with #async", async () => {
  const { yaml, sns } = await generate();
  assert.deepEqual(sns, ["CAM1"]);
  assert.match(yaml, /CAM1: ffmpeg:http:\/\/127\.0\.0\.1:3000\/stream\/CAM1#video=copy#async/);
});

test("a device without a stream path is left out", async () => {
  const { yaml } = await generate();
  assert.ok(!yaml.includes("SENSOR1"), "non-camera devices must not become go2rtc streams");
});

test("go2rtc listens on 1984/8554/8555 by default", async () => {
  const { yaml } = await generate();
  assert.match(yaml, /api:\n  listen: ":1984"\nrtsp:\n  listen: ":8554"\nwebrtc:\n  listen: ":8555"\n/);
});

test("moved go2rtc ports reach both the YAML and the stream.start RTSP URL", async () => {
  const ctx = loadConfig({
    EUFY_EMAIL: "x@y.z",
    EUFY_PASSWORD: "pw",
    GO2RTC_API_PORT: "11984",
    GO2RTC_RTSP_PORT: "18554",
    GO2RTC_WEBRTC_PORT: "18555",
  });
  const { yaml } = await generate(ctx.cfg);
  assert.match(yaml, /api:\n  listen: ":11984"\nrtsp:\n  listen: ":18554"\nwebrtc:\n  listen: ":18555"\n/);

  ctx.state = createState();
  ctx.state.flags.ready = true; // stream.start needs an authenticated session
  ctx.eufy = {};
  Object.assign(ctx, createWsServer(ctx, http.createServer()));
  const sent = [];
  const ws = { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) };
  await ctx.handleMessage(ws, Buffer.from(JSON.stringify({ id: 1, cmd: "stream.start", sn: "CAM1" })));
  assert.equal(sent[0].rtsp, "rtsp://127.0.0.1:18554/CAM1");
});

test("known indoor H.264 feeds bypass format probing without transcoding or losing #async", async () => {
  const { yaml, sns } = await generate({}, [
    { sn: "INDOOR1", model: "T8400", stream: "/stream/INDOOR1" },
    { sn: "INDOOR2", model: "T8410", stream: "/stream/INDOOR2" },
    { sn: "OTHER", model: "T8416", stream: "/stream/OTHER" },
    { sn: "UNKNOWN", stream: "/stream/UNKNOWN" },
  ]);
  assert.deepEqual(sns, ["INDOOR1", "INDOOR2", "OTHER", "UNKNOWN"]);
  assert.ok(yaml.includes('ffmpeg:\n  eufy_h264: "-analyzeduration 0 -probesize 32768 -f h264 -i {input}"\n'));
  for (const sn of ["INDOOR1", "INDOOR2"]) {
    assert.ok(yaml.includes(`${sn}: ffmpeg:http://127.0.0.1:3000/stream/${sn}#video=copy#async#input=eufy_h264\n`));
  }
  for (const sn of ["OTHER", "UNKNOWN"]) {
    assert.ok(yaml.includes(`${sn}: ffmpeg:http://127.0.0.1:3000/stream/${sn}#video=copy#async\n`));
  }
});

test("the input selection also preserves advertised optical-view paths", async () => {
  const { yaml } = await generate({}, [
    {
      sn: "INDOOR",
      model: "T8410",
      stream: "/stream/INDOOR",
      views: [{ id: "INDOOR_MAIN", stream: "/stream/INDOOR?view=main" }],
    },
  ]);
  assert.ok(
    yaml.includes(
      "INDOOR_MAIN: ffmpeg:http://127.0.0.1:3000/stream/INDOOR?view=main#video=copy#async#input=eufy_h264\n",
    ),
  );
});
