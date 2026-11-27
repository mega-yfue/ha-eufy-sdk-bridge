// The recordings a HomeBase 3 keeps for each camera. The station lists them in its own
// `history_record_info` table, which its direct read answers with the current day's rows only;
// `downloadRecording` fetches one by name over the station's P2P session without waking the camera, and
// the bundled ffmpeg muxes it into an mp4 (see clip.mjs). Older recordings stay downloadable by name until
// the station's storage rolls over (about two weeks on a HomeBase 3).
//
//   GET /recordings/<sn>          today's recordings for a camera, newest first, as JSON
//   GET /recording/<sn>/<name>    one recording, as an mp4
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { muxMp4 } from "./clip.mjs";

const STAMP = /^\d{14}$/;

/** A `YYYY-MM-DD HH:MM:SS` station-local time and its `±HHMM` zone as a Date, else undefined. */
export function stationTime(local, zone) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(local ?? "");
  const z = /^([+-]\d{2})(\d{2})$/.exec(zone ?? "");
  if (!m || !z) return undefined;
  const at = new Date(`${m[1]}T${m[2]}${z[1]}:${z[2]}`);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** The station-local `yyyyMMddHHmmss` a recording is named for, in its row's zone, as a Date. */
export function stampTime(stamp, zone) {
  const s = String(stamp);
  return stationTime(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`,
    zone,
  );
}

/**
 * One `history_record_info` row as a recording, or undefined for a row that stored no video (a lock or
 * doorbell event without a clip). `name` is what `downloadRecording` takes; `cipherId` resolves a cipher
 * id above 24 bits through its low byte, as the SDK's guide derives it.
 */
export function recordingOf(row) {
  const r = row?.payload ?? row;
  const name = r?.storage_path ? path.posix.parse(r.storage_path).name : undefined;
  if (!r?.device_sn || !STAMP.test(name ?? "") || !(r.frame_num > 0)) return undefined;
  const cipher = Number(r.cipher_id) || 0;
  return {
    deviceSn: r.device_sn,
    name,
    cipherId: cipher > 0xffffff ? cipher & 0xff : cipher,
    start: stampTime(name, r.time_zone) ?? stationTime(r.start_time, r.time_zone),
    end: stationTime(r.end_time, r.time_zone),
    frames: r.frame_num,
    trigger: r.trigger_type,
  };
}

/** The JSON a recording is listed as. */
const listed = (rec) => ({
  name: rec.name,
  cipherId: rec.cipherId,
  start: rec.start?.toISOString(),
  end: rec.end?.toISOString(),
  frames: rec.frames,
  trigger: rec.trigger,
});

export function createRecordings(ctx) {
  const { eufy } = ctx;
  const mux = ctx.muxClip ?? muxMp4;
  const log = (...a) => ctx.eventLog?.(...a);

  /** The camera's SDK handle when it offers stored recordings: `{ cam, device }`, or `{ status, error }`. */
  async function cameraOf(sn) {
    let device;
    try {
      device = await eufy.getDevice(sn);
    } catch (e) {
      return { status: 404, error: String(e?.message ?? e) };
    }
    const cam = device.camera?.();
    if (typeof cam?.downloadRecording !== "function")
      return { status: 404, error: "no stored recordings on this device" };
    return { cam, device };
  }

  /** The station serial a camera's recordings are listed by. */
  async function stationOf(sn, device) {
    const own = device?.stationSn ?? device?.raw?.station_sn;
    if (own) return own;
    const listed = (await eufy.getDevices()).find((d) => (d.sn ?? d.serialNumber) === sn);
    return listed?.stationSn ?? listed?.raw?.station_sn;
  }

  /** Every recording a station lists today, by camera serial, newest first. */
  async function stationRecordings(stationSn) {
    const read = () => eufy.readStationTable(stationSn, "history_record_info");
    const rows = await (ctx.withDbLock ? ctx.withDbLock(read) : read());
    const byCamera = new Map();
    for (const row of rows) {
      const rec = recordingOf(row);
      if (!rec) continue;
      const list = byCamera.get(rec.deviceSn) ?? [];
      if (!list.some((r) => r.name === rec.name)) list.push(rec);
      byCamera.set(rec.deviceSn, list);
    }
    for (const list of byCamera.values()) list.sort((a, b) => b.name.localeCompare(a.name));
    return byCamera;
  }

  /** `{ recordings }` for `sn`, or `{ status, error }`. */
  async function listRecordings(sn) {
    const found = await cameraOf(sn);
    if (!found.cam) return found;
    const stationSn = await stationOf(sn, found.device);
    if (!stationSn) return { status: 404, error: "no station for this device" };
    try {
      const list = (await stationRecordings(stationSn)).get(sn) ?? [];
      return { recordings: list.map(listed) };
    } catch (e) {
      log(`/recordings ${sn} failed: ${e?.message ?? e}`);
      return { status: 502, error: String(e?.message ?? e) };
    }
  }

  /** One recording of `sn` as `{ mp4 }`, or `{ status, error, reason? }`. */
  async function recordingMp4(sn, name, { cipherId = 0 } = {}) {
    if (!STAMP.test(name)) return { status: 400, error: "a recording name is its yyyyMMddHHmmss stamp" };
    const found = await cameraOf(sn);
    if (!found.cam) return found;
    try {
      const clip = await found.cam.downloadRecording({ recording: name, cipherId });
      const file = path.join(ctx.eventImageDir, `recording-${sn}-${name}-${randomUUID()}.mp4`); // one per request
      const mp4 = await muxToBuffer(clip, file);
      log(
        `/recording ${sn} ${name}: ${clip.frames} frames, ${clip.missingFrames} missing, ${clip.durationMs} ms` +
          `${clip.codec ? `, ${clip.codec}` : ""}${clip.audio?.length ? ", with audio" : ""}`,
      );
      return { mp4, clip };
    } catch (e) {
      log(`/recording ${sn} ${name} failed: ${e?.message ?? e}`);
      if (e?.reason === "no-data") return { status: 404, error: String(e.message), reason: e.reason };
      return e?.reason
        ? { status: 502, error: String(e.message), reason: e.reason }
        : { status: 500, error: String(e?.message ?? e) };
    }
  }

  /** Mux `clip` through `file` and answer the mp4's bytes, leaving nothing behind. */
  async function muxToBuffer(clip, file) {
    try {
      await mux(clip, file);
      return await fs.promises.readFile(file);
    } finally {
      await fs.promises.rm(file, { force: true });
    }
  }

  return { listRecordings, recordingMp4, stationRecordings, cameraOf, stationOf };
}
