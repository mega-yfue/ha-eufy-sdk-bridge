// Answer /stream at once, before a sleeping camera has woken.
//
// go2rtc serves each camera from `ffmpeg:<this bridge's /stream>`, and its RTSP server answers DESCRIBE only
// once that ffmpeg has probed the codec — i.e. once the first frames arrived. A battery camera on 4G/P2P needs
// 6-20 s to wake and send them, but the RTSP client on the other end (Home Assistant's own go2rtc) waits a
// FIXED 5 s for the DESCRIBE response (`Conn.ReadResponse`, not covered by `#timeout`) and gives up with
// "i/o timeout". The picture then only appears on a second try, while the camera is still awake.
//
// So /stream starts with the camera's last live keyframe (kept by live-still.mjs from the previous viewing)
// and repeats it until the live feed takes over — fast at first, so ffmpeg finishes probing and DESCRIBE is
// answered within about two seconds, then slowly, which keeps the consumer's frame-read deadline (also 5 s)
// from expiring meanwhile. The
// viewer sees the last picture, then the live one. A keyframe carries its own parameter sets, so each repeat
// decodes on its own; go2rtc's `#async` re-stamps frames from the wall clock, so repeats need no timestamps.
import fs from "node:fs";
import { keyframeCodec, lastLiveKeyframeFile } from "./live-still.mjs";

/** The kept keyframe of a camera as `{ au, codec }`, or null when there is none (or it is not a keyframe). */
export async function loadPrimer(dir, sn) {
  if (!dir) return null;
  try {
    const au = await fs.promises.readFile(lastLiveKeyframeFile(dir, sn));
    const codec = keyframeCodec(au);
    return codec ? { au, codec } : null;
  } catch {
    return null; // never watched yet — the stream starts the old way
  }
}

/**
 * Write `au` to `res` now and repeatedly until the returned stop() is called: every `fastMs` for the first
 * `fastForMs`, then every `intervalMs`. Writes stop by themselves once the response is gone. The response's
 * headers must already be sent.
 *
 * The fast phase is what gets DESCRIBE answered in time: go2rtc's ffmpeg publishes only once
 * avformat_find_stream_info is done, and for raw H.264 that waits for ~20 frames or 5 s of (wall-clock)
 * timestamps. At one frame per 500 ms that is 5 s — exactly the consumer's DESCRIBE deadline, so the start
 * became a race. Ten frames a second finish the probe in about two seconds; afterwards a slow repeat is
 * enough to keep the consumer's frame-read deadline from expiring.
 */
export function startPrimer(res, au, { intervalMs = 500, fastMs = 100, fastForMs = 3000 } = {}) {
  const write = () => {
    if (!res.destroyed && !res.writableEnded) res.write(au);
  };
  write();
  let timer = setInterval(write, Math.min(fastMs, intervalMs));
  timer.unref?.();
  const slowDown = setTimeout(() => {
    clearInterval(timer);
    timer = setInterval(write, intervalMs);
    timer.unref?.();
  }, fastForMs);
  slowDown.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(slowDown);
    clearInterval(timer);
  };
}
