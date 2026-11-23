// "Take screenshot": a fresh still straight from the camera, kept as its LAST SCREEN (last-live-<sn>.jpg, the
// picture GET /last-screen and /snapshot?mode=screen serve). Only on demand - a battery camera is woken for it
// (10-20 s), which is the point of pressing the button; nothing in the bridge calls this on a timer.
// Watching the camera live keeps the last screen current too (live-still.mjs), without extra wakes.
import fs from "node:fs";
import path from "node:path";
import { cameraViews, cameraView, validView } from "./camera-views.mjs";

/** Take a live still of `sn`, store it as the last screen and announce lastScreenUpdated. */
export async function takeScreenshot(ctx, sn, view = 0) {
  if (!validView(view)) throw new RangeError("view must be a non-negative safe integer");
  const cam = (await ctx.eufy.getDevice(sn)).camera?.();
  if (!cam?.snapshotLive) throw new Error("no camera on this device");
  if (!cameraViews(cam).includes(view)) throw new RangeError("unsupported camera view");
  const source = cameraView(sn, view);
  const { jpeg } = (await cam.snapshotLive(view === 0 ? undefined : { view })) ?? {};
  if (!jpeg?.length) throw new Error("the camera returned no picture");
  await fs.promises.writeFile(path.join(ctx.eventImageDir, `last-live-${source.id}.jpg`), jpeg);
  ctx.eventLog?.(`screen.take ${sn} → kept a fresh still as the last screen (${jpeg.length}B)`);
  ctx.broadcast?.({ event: "lastScreenUpdated", deviceSn: sn, ...(view === 0 ? {} : { view }) });
  return { bytes: jpeg.length };
}
