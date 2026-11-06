// How /stream opens a camera's live video as a raw Annex-B Readable.
//
// The SDK offers `openReadable` only on devices whose codec is "camera". A camera-capable device with
// another codec (the T8530 Video Smart Lock is codec "lock") still has the ungated `live()`, which attaches
// to the same shared live source and hands back a consumer emitting one access unit per `video` event.
// For those, wrap the consumer the way the SDK's own readable egress does.
//
// The same wrapper serves a caller that wants the battery-budget notice. The SDK bounds a battery camera's
// stream to a budget (45 s by default), then emits `budget` on each consumer with an `extend()` handle and a
// 10 s grace before it stops the stream. openReadable() drops that event, so a watched battery stream would
// always end after ~55 s: the viewer froze and only reopening the view brought the picture back.
import { Readable } from "node:stream";

/**
 * The function that opens this camera's live feed, or undefined when it has no live video at all.
 * Prefers the SDK's `openReadable`; falls back to `live()`. `onBudget(notice)` is called for each
 * battery-budget notice (`notice.extend(ms?)` keeps the stream going), which only `live()` can report, so
 * passing it prefers `live()` instead.
 */
export function liveFeedOpener(cam, { onBudget } = {}) {
  if (cam?.live && (onBudget || !cam.openReadable))
    return async (opts) => {
      const feed = readableFromLive(await cam.live(opts));
      if (onBudget) feed.on("budget", onBudget);
      return feed;
    };
  if (cam?.openReadable) return (opts) => cam.openReadable(opts);
  return undefined;
}

/**
 * A raw Annex-B Readable over a `live()` consumer. Backpressure pauses the consumer, so a slow reader
 * drops to the next keyframe inside the SDK instead of buffering here. Destroying the Readable stops the
 * consumer, which detaches it from the shared source.
 */
export function readableFromLive(consumer) {
  const readable = new Readable({
    read() {
      consumer.resume?.();
    },
    destroy(err, cb) {
      consumer.stop();
      cb(err);
    },
  });
  consumer.on("video", (frame) => {
    if (!readable.push(frame.data)) consumer.pause?.();
  });
  consumer.on("budget", (notice) => readable.emit("budget", notice));
  consumer.on("stop", () => readable.push(null));
  consumer.on("error", (err) => readable.destroy(err));
  return readable;
}
