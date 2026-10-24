// Live audio for /audio/<sn>: the camera's AAC-LC as a raw ADTS byte stream, which go2rtc reads as a second
// source next to /stream's video.
//
// /stream can't carry it: openReadable() is video-only by the SDK's contract (audio is never interleaved
// into raw Annex-B). live() is the SDK's audio egress, and it joins the SAME shared pull as /stream, so
// sound costs no second P2P session. Measured on a T8200: codec id 0 (aac-lc), every frame one ADTS frame
// (16 kHz), ~15.6 frames/s — the bytes are served exactly as the station sent them.
import { Readable } from "node:stream";

/** Content type of an /audio response: ADTS-framed AAC. */
export const ADTS_CONTENT_TYPE = "audio/aac";

const NO_LIVE_AUDIO = "NO_LIVE_AUDIO";

/**
 * True for the rejection {@link openAdts} gives when the camera serves no aac-lc audio. The camera did not
 * fail — its video may be streaming fine — so this is no reason to back off or drop its client.
 */
export const isNoLiveAudio = (e) => e?.code === NO_LIVE_AUDIO;

/**
 * Wait for a live() consumer's first `aac-lc` frame, then resolve with a Readable of ADTS bytes that starts
 * with it. Only `aac-lc` is served: its frames arrive ADTS-framed, so they concatenate into a valid .aac
 * stream, while `aac-eld` (raw access units) and `g711a` would need framing of their own.
 *
 * Rejects — {@link isNoLiveAudio} — when the camera declares another codec, when video flows for `quietMs`
 * without an audio frame (a microphone that is off sends none), or when nothing arrives within `timeoutMs`.
 * Deciding before the response starts is what keeps video safe: go2rtc dials a stream's sources one after
 * another, and its ADTS reader blocks until it sees a header, so an /audio left open without bytes holds
 * every viewer's DESCRIBE — video too — while a 404 lets go2rtc carry on with video alone.
 *
 * Destroying the Readable stops the consumer, which releases the shared pull.
 */
export function openAdts(handle, { quietMs = 3000, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let quiet;
    const stop = () => {
      try {
        handle.stop();
      } catch {
        /* already detached */
      }
    };
    const out = new Readable({
      read() {}, // ~3 KB/s: nothing for backpressure to save, and pausing would hold the shared source's queue
      destroy(err, cb) {
        stop();
        cb(err);
      },
    });
    const settle = () => {
      settled = true;
      clearTimeout(overall);
      clearTimeout(quiet);
      handle.off?.("video", onVideo);
    };
    const fail = (err) => {
      if (settled) return;
      settle();
      stop();
      reject(err);
    };
    const giveUp = (why) => fail(Object.assign(new Error(`no live audio: ${why}`), { code: NO_LIVE_AUDIO }));
    const overall = setTimeout(() => giveUp(`nothing arrived within ${timeoutMs} ms`), timeoutMs);
    function onVideo() {
      quiet ??= setTimeout(() => giveUp(`video arrived, but no audio within ${quietMs} ms`), quietMs);
    }
    handle.on("video", onVideo);
    handle.on("audio", (frame) => {
      if (frame.codec !== "aac-lc") {
        // Before the response starts this decides it; afterwards a frame we can't serve is skipped.
        giveUp(`the camera sends ${frame.codec}; only ADTS-framed aac-lc is served`);
        return;
      }
      out.push(frame.data);
      if (settled) return;
      settle();
      resolve(out);
    });
    // Upstream ended: EOF once the response is under way, "no audio" before it.
    handle.on("stop", () => (settled ? out.push(null) : giveUp("the stream stopped before any audio")));
    handle.on("error", (err) => {
      if (settled) out.destroy(err);
      else fail(err);
    });
  });
}
