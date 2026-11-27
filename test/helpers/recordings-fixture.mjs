// A fake HomeBase 3 with two cameras for the recordings tests: its table rows, SDK handles, and the HTTP
// handler over them. The muxer is faked, so ffmpeg is not needed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import { loadConfig } from "../../src/config.mjs";
import { createState } from "../../src/state.mjs";
import { createHttpHandler } from "../../src/http-routes.mjs";
import { createRecordings } from "../../src/recordings.mjs";

/** A `history_record_info` row as a HomeBase 3 answers it, for camera `sn` recorded at `stamp`. */
export const row = (sn, stamp, extra = {}) => ({
  device_sn: sn,
  station_sn: "STATION1",
  storage_path: `/zx/emmcdata/Camera02/${stamp.slice(0, 6)}/${stamp}/${stamp}.zxvideo`,
  cipher_id: 0,
  frame_num: 300,
  start_time: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`,
  end_time: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:59`,
  time_zone: "-0600",
  trigger_type: 4,
  ...extra,
});

/** `modules` are further factories merged into ctx, as server.mjs does. */
export function setup({ rows = [], env = {}, download, streaming = [], modules = [], muxClip } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordings-"));
  const calls = { download: [], table: 0, locked: 0 };
  const cams = new Map(
    ["CAM1", "CAM2"].map((sn) => [
      sn,
      {
        downloadRecording: async (opts) => {
          calls.download.push({ sn, ...opts });
          return download ? download(sn, opts) : { video: Buffer.from(`${sn}:${opts.recording}`), frames: 300 };
        },
      },
    ]),
  );
  const devices = [{ sn: "CAM1", stationSn: "STATION1" }, { sn: "CAM2", stationSn: "STATION1" }, { sn: "STATION1" }];
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", ...env });
  const state = createState();
  state.flags.ready = true;
  for (const sn of streaming) state.streaming.add(sn);
  const ctx = {
    ...config,
    state,
    eventImageDir: dir,
    eventLog: () => {},
    authStatus: () => ({ status: "ok" }),
    withDbLock: (fn) => (calls.locked++, fn()),
    eufy: {
      getDevices: async () => devices,
      getDevice: async (sn) => ({ ...devices.find((d) => d.sn === sn), camera: () => cams.get(sn) }),
      readStationTable: async (stationSn, table) => {
        assert.deepEqual([stationSn, table], ["STATION1", "history_record_info"]);
        calls.table++;
        return typeof rows === "function" ? rows() : rows;
      },
    },
    muxClip:
      muxClip ?? (async (clip, out) => fs.promises.writeFile(out, Buffer.concat([Buffer.from("MP4:"), clip.video]))),
  };
  Object.assign(ctx, createRecordings(ctx));
  for (const create of modules) Object.assign(ctx, create(ctx));
  return { handler: createHttpHandler(ctx), ctx, calls, dir };
}

export async function get(handler, url) {
  const out = {};
  const res = {
    writeHead(code, headers) {
      out.code = code;
      out.headers = headers;
    },
    end(body) {
      out.body = body;
    },
  };
  await handler({ url, headers: { host: "localhost" }, on() {} }, res);
  return out;
}

/** Every file under `dir`, relative to it. */
export const files = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile())
    : [];
