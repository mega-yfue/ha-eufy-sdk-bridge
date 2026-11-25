// How /audio serves a camera's live sound as a raw ADTS AAC byte stream.
//
// /stream carries video only: it is built on `openReadable()`, which returns Annex-B video bytes and
// drops the audio frames the station sends in the same P2P session. The SDK's `live()` consumer exposes
// those frames as `audio` events. For AAC-LC each event is one whole ADTS frame, so writing them back to
// back is already a valid `.aac` stream that ffmpeg reads with `-f aac`, with no muxing in the bridge.
//
// AAC-ELD (raw access units that need an out-of-band AudioSpecificConfig) and G.711 A-law (no sample rate
// on the wire) cannot be framed as ADTS without guessing, so they are skipped and logged once.
import { Readable } from "node:stream";

export const ADTS_CODEC = "aac-lc";

/**
 * A Readable of ADTS AAC over a `live()` consumer. Only AAC-LC frames are forwarded; other audio codecs
 * are reported once through `onUnsupported(codec)` and skipped. Video frames are ignored. Backpressure
 * pauses the consumer; destroying the Readable stops it, which detaches it from the shared live source.
 */
export function audioReadableFromLive(consumer, { onUnsupported = () => {} } = {}) {
  const reported = new Set();
  const readable = new Readable({
    read() {
      consumer.resume?.();
    },
    destroy(err, cb) {
      consumer.stop();
      cb(err);
    },
  });
  consumer.on("audio", (frame) => {
    if (frame?.codec !== ADTS_CODEC) {
      if (!reported.has(frame?.codec)) {
        reported.add(frame?.codec);
        onUnsupported(frame?.codec);
      }
      return;
    }
    if (!readable.push(frame.data)) consumer.pause?.();
  });
  consumer.on("stop", () => readable.push(null));
  consumer.on("error", (err) => readable.destroy(err));
  return readable;
}
