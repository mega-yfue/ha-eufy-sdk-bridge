// Keep a battery camera's LIVE picture as its still — taken from a stream that is already running, never by
// waking the camera for it. With SNAPSHOT_LIVE=auto a battery camera answers /snapshot from disk, and until
// now that meant the last event's thumbnail, which can be days old while someone watched the camera an hour
// ago. /stream already carries every frame through the bridge, so a watched stream's keyframes are turned
// into last-live-<sn>.jpg as it runs and once more when it ends; /snapshot serves whichever picture is newer.
//
// Each chunk of an openReadable() feed is one whole access unit, and keyframes carry their own parameter
// sets (SDK live-media docs), so a single keyframe decodes on its own — no SDK call, no extra P2P traffic.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Where the newest live keyframe of a camera is kept as raw Annex-B (beside last-live-<sn>.jpg). */
export const lastLiveKeyframeFile = (dir, sn) => path.join(dir, `last-live-${sn}.annexb`);

/**
 * The codec of an Annex-B access unit that carries parameter sets — i.e. a keyframe that decodes on its own —
 * else null. H.264 is recognised by its SPS (type 7). H.265 needs BOTH its VPS (type 32) and SPS (type 33):
 * the VPS header byte 0x40/0x41 is also what the commonest H.264 delta slice starts with (0x41), so one
 * matching header is not proof. A layer-0 H.265 header byte is even, so it never reads as an H.264 SPS (odd).
 */
export function keyframeCodec(au) {
  let vps = false;
  let sps265 = false;
  for (let i = 0; i + 4 < au.length; i++) {
    if (au[i] !== 0 || au[i + 1] !== 0 || au[i + 2] !== 1) continue; // start code (a 4-byte one ends the same)
    const b = au[i + 3];
    if ((b & 0x80) === 0 && (b & 0x1f) === 7) return "h264";
    const type265 = (b >> 1) & 0x3f;
    if (au[i + 4] === 0x01 && type265 === 32) vps = true;
    if (au[i + 4] === 0x01 && type265 === 33) sps265 = true;
  }
  return vps && sps265 ? "hevc" : null;
}

/** Decode one keyframe access unit to a JPEG with the ffmpeg the image already ships (for go2rtc). */
export function accessUnitToJpeg(au, codec, { ffmpeg = "ffmpeg", timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      codec,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-pix_fmt",
      "yuvj420p",
      "-q:v",
      "3",
      "-f",
      "image2",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ];
    const proc = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let err = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (c) => out.push(c));
    proc.stderr.on("data", (c) => {
      err += c;
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(out);
      if (code === 0 && jpeg.length) resolve(jpeg);
      else reject(new Error(`ffmpeg exited ${code}${err ? `: ${err.trim().slice(0, 200)}` : ""}`));
    });
    proc.stdin.on("error", () => {}); // ffmpeg may stop reading once it has its one frame
    proc.stdin.end(au);
  });
}

/**
 * Watch one /stream feed and keep its picture on disk as last-live-<sn>.jpg: first `firstAfterMs` into the
 * stream (the very first frames after a wake are often mis-exposed while exposure and IR settle), then every
 * `everyMs` while it runs, and once more on flush() when it ends. Saving DURING the stream matters because a
 * consumer can hold a stream well past the viewer: HA keeps an unused HLS output open for 60s, so a still
 * written only at the end showed up a minute late. Pacing is driven by arriving keyframes, not timers.
 * Conversions never overlap, and flush() is safe to call more than once (the route's cleanup can fire from
 * several events).
 */
export function createLiveStillTap({
  sn,
  dir,
  toJpeg = accessUnitToJpeg,
  log = () => {},
  onSaved = () => {},
  firstAfterMs = 5_000,
  everyMs = 30_000,
  now = Date.now,
}) {
  let startedAt = null;
  let lastSaveAt = null;
  let latest = null; // { au, codec, seq }
  let seq = 0;
  let savedSeq = 0;
  let busy = null;
  let flushing = null;

  const save = (frame) => {
    busy = (async () => {
      try {
        const jpeg = await toJpeg(frame.au, frame.codec);
        await fs.promises.writeFile(path.join(dir, `last-live-${sn}.jpg`), jpeg);
        // The same keyframe, undecoded: the next /stream answers with it at once (see stream-primer.mjs).
        await fs.promises.writeFile(lastLiveKeyframeFile(dir, sn), frame.au);
        savedSeq = Math.max(savedSeq, frame.seq);
        log(`/stream ${sn} → kept the live picture as the still (${jpeg.length}B, ${frame.codec})`);
        // "Last screen" consumers (HA image entity) refresh on this instead of polling.
        try {
          onSaved();
        } catch {
          /* a listener failure must not affect the stream */
        }
        return true;
      } catch (e) {
        log(`/stream ${sn} → could not keep the live picture: ${e?.message ?? e}`);
        return false;
      } finally {
        busy = null;
      }
    })();
    return busy;
  };

  return {
    onChunk(chunk) {
      const t = now();
      startedAt ??= t;
      const codec = keyframeCodec(chunk);
      if (!codec) return;
      latest = { au: Buffer.from(chunk), codec, seq: ++seq }; // a copy: the feed may reuse its buffers
      const due = lastSaveAt == null ? t - startedAt >= firstAfterMs : t - lastSaveAt >= everyMs;
      if (due && !busy && !flushing) {
        lastSaveAt = t;
        void save(latest);
      }
    },
    /** Resolves once no conversion is running (for callers and tests that must not race a save). */
    idle() {
      return busy ?? Promise.resolve();
    },
    /** Save the newest keyframe if it has not been saved yet. Resolves true when a file was written. */
    flush() {
      flushing ??= (async () => {
        if (busy) await busy;
        if (!latest || latest.seq <= savedSeq) return false;
        return save(latest);
      })();
      return flushing;
    },
  };
}
