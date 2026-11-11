// Per-device "last heard locally" clock. The cloud `lastSeen` lies for devices that report locally but
// not to the cloud (battery cams on a HomeBase, standalone RTC devices like a T8223 doorbell or a T8N00
// NVR), so a device can be perfectly alive — pushing detections, property changes, command acks — while
// its cloud timestamp goes stale and the host falsely marks it UNAVAILABLE. Any inbound event from a
// device is honest proof it is alive right now, so the bridge stamps the moment it last heard ANYTHING
// from each device; `liveness()` treats recent local activity as reachable.

/** A tiny last-heard registry: `noteActivity(sn)` stamps now, `heardMs(sn)` reads it back. */
export function createActivity() {
  const heard = new Map(); // sn -> ms of the last inbound signal from that device

  /** Record that we just heard from `sn` (any inbound event). A falsy serial is ignored. */
  function noteActivity(sn) {
    if (!sn) return;
    heard.set(sn, Date.now());
  }

  /** When the bridge last heard from `sn`, in ms, or `undefined` if never. */
  function heardMs(sn) {
    return heard.get(sn);
  }

  return { noteActivity, heardMs };
}
