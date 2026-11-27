// /clip/<sn>: the recording a HomeBase 2 stored for a camera's latest detection, as an mp4. The push names
// the recording (`payload.p`) and its key (`cipher`); the SDK's `downloadRecording` fetches it over the
// station's P2P session without waking the camera, and the bundled ffmpeg muxes the elementary streams
// it returns (no re-encode). One file per camera holds the latest clip, so nothing needs pruning.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The ffmpeg arguments that mux `video` (read from `videoIn`) and `audio` (from `audioIn`) into `out`. */
export function muxArgs({ codec, audio, fps, frames, missingFrames, durationMs }, videoIn, audioIn, out) {
  const hevc = codec === "h265";
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-fflags", "+genpts"];
  // A raw stream carries no timestamps, so ffmpeg spaces the pictures evenly. With pictures missing,
  // spacing them at the camera's rate would end the video early and pull it ahead of the audio, so they
  // are spread over the recording's own span instead.
  const rate = missingFrames > 0 && frames > 1 && durationMs > 0 ? ((frames - 1) * 1000) / durationMs : fps;
  // `-r` sets the input rate. `-framerate` does not: the raw demuxer keeps the rate the stream's own
  // timing info declares, which can differ from the rate the camera recorded at.
  if (rate > 0) args.push("-r", String(Math.round(rate * 1000) / 1000));
  args.push("-f", hevc ? "hevc" : "h264", "-i", videoIn);
  if (audio?.length) args.push("-f", "aac", "-i", audioIn, "-map", "0:v", "-map", "1:a");
  args.push("-c", "copy");
  // The parameter sets travel in-band with every keyframe, which is what an `hev1` sample entry declares.
  if (hevc) args.push("-tag:v", "hev1");
  args.push("-movflags", "+faststart", "-f", "mp4", out);
  return args;
}

/** Mux Annex-B H.264 or H.265 (+ ADTS AAC when present) into `out` with ffmpeg, stream copy only. */
export async function muxMp4(clip, out) {
  const { video, audio } = clip;
  const inputs = [`${out}.${clip.codec === "h265" ? "h265" : "h264"}`, `${out}.aac`];
  try {
    await fs.promises.writeFile(inputs[0], video);
    if (audio?.length) await fs.promises.writeFile(inputs[1], audio);
    const args = muxArgs(clip, inputs[0], inputs[1], out);
    await new Promise((resolve, reject) =>
      execFile("ffmpeg", args, { timeout: 60_000 }, (e, _out, err) => {
        if (!e) return resolve();
        const detail = String(err || e.message).trim();
        reject(new Error(`ffmpeg: ${detail.slice(-200)}`));
      }),
    );
  } catch (e) {
    await fs.promises.rm(out, { force: true }); // no half-written file left behind
    throw e;
  } finally {
    for (const f of inputs) await fs.promises.rm(f, { force: true });
  }
}

export function createClips(ctx) {
  const { cfg, eufy, eventImageDir } = ctx;
  const mux = ctx.muxClip ?? muxMp4;
  const log = (...a) => ctx.eventLog?.(...a);
  const latest = new Map(); // sn -> { recording, cipherId, at } from the camera's latest push
  const made = new Map(); // sn -> the recording last-clip-<sn>.mp4 holds
  const builds = new Map(); // sn -> { recording, done } for the build in progress

  /** `push` listener: remember the recording a detection named. */
  function noteRecording(ev) {
    const recording = ev?.payload?.p;
    if (!ev?.deviceSn || typeof recording !== "string" || ev.cipher === undefined) return;
    if (latest.get(ev.deviceSn)?.recording === recording) return; // a repeat of the same push
    latest.set(ev.deviceSn, { recording, cipherId: ev.cipher, at: Date.now() });
  }

  async function build(sn, cam, { recording, cipherId, at }, file) {
    // The station is still writing the recording right after the push; how it answers then is not
    // established, so wait until the clip length has elapsed.
    const wait = at + cfg.clipSettleMs - Date.now();
    if (wait > 0) await sleep(wait);
    const clip = await cam.downloadRecording({ recording, cipherId });
    const tmp = `${file}.tmp`;
    await mux(clip, tmp);
    await fs.promises.rename(tmp, file);
    made.set(sn, recording);
    log(
      `/clip ${sn} → recording ${recording}: ${clip.frames} frames, ${clip.missingFrames} missing, ` +
        `${clip.durationMs} ms${clip.audio?.length ? ", with audio" : ""}`,
    );
    return fs.promises.readFile(file);
  }

  /** The latest detection's clip for `sn`: `{ mp4 }`, or `{ status, error, reason? }`. */
  async function clipFor(sn) {
    let cam;
    try {
      cam = (await eufy.getDevice(sn)).camera?.();
    } catch (e) {
      return { status: 404, error: String(e?.message ?? e) };
    }
    if (typeof cam?.downloadRecording !== "function")
      return { status: 404, error: "no stored recordings on this device" };
    const last = latest.get(sn);
    if (!last) return { status: 409, error: "no recording named by a push since the bridge started" };
    const file = path.join(eventImageDir, `last-clip-${sn}.mp4`);
    if (made.get(sn) === last.recording) {
      try {
        return { mp4: await fs.promises.readFile(file) };
      } catch {
        made.delete(sn); // gone from disk: build it again
      }
    }
    // One build per camera at a time: callers asking for the same recording share it, and a newer
    // recording waits for the one in progress so the file ends up holding the newer clip.
    let current = builds.get(sn);
    if (current?.recording !== last.recording) {
      const previous = current?.done.catch(() => {}) ?? Promise.resolve();
      const entry = { recording: last.recording };
      entry.done = previous.then(() => build(sn, cam, last, file));
      entry.done.finally(() => builds.get(sn) === entry && builds.delete(sn)).catch(() => {});
      builds.set(sn, (current = entry));
    }
    try {
      return { mp4: await current.done };
    } catch (e) {
      log(`/clip ${sn} → recording ${last.recording} failed: ${e?.message ?? e}`);
      return e?.reason
        ? { status: 502, error: String(e.message), reason: e.reason }
        : { status: 500, error: String(e?.message ?? e) };
    }
  }

  return { noteRecording, clipFor };
}
