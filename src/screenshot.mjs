// "Take screenshot": a fresh still straight from the camera, kept as its LAST SCREEN (last-live-<sn>.jpg, the
// picture GET /last-screen and /snapshot?mode=screen serve). Only on demand - a battery camera is woken for it
// (10-20 s), which is the point of pressing the button; nothing in the bridge calls this on a timer.
// Watching the camera live keeps the last screen current too (live-still.mjs), without extra wakes.
import fs from "node:fs";
import path from "node:path";

/** Take a live still of `sn`, store it as the last screen and announce lastScreenUpdated. */
export async function takeScreenshot(ctx, sn) {
  const cam = (await ctx.eufy.getDevice(sn)).camera?.();
  if (!cam?.snapshotLive) throw new Error("no camera on this device");
  const { jpeg } = (await cam.snapshotLive()) ?? {};
  if (!jpeg?.length) throw new Error("the camera returned no picture");
  await fs.promises.writeFile(path.join(ctx.eventImageDir, `last-live-${sn}.jpg`), jpeg);
  ctx.eventLog?.(`screen.take ${sn} → kept a fresh still as the last screen (${jpeg.length}B)`);
  ctx.broadcast?.({ event: "lastScreenUpdated", deviceSn: sn });
  return { bytes: jpeg.length };
}
