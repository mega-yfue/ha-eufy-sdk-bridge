// When the bridge first saw each camera's retained push thumbnail. The SDK hands the thumbnail back as bare
// bytes, with no time, and keeps it until a newer PUSH replaces it. On a local-storage account the cloud
// attaches a thumbnail to only some events, while the on-detection HomeBase refresh persists each event's
// cover to disk, so the retained thumbnail is often OLDER than the disk copy. Knowing when it appeared lets
// /event-image and the detection follow-up tell "this event's thumbnail" from "an earlier event's", and
// never write the older picture over the newer one (ha-eufy-sdk-bridge#97).

/** Record `jpeg` as `sn`'s retained thumbnail and return when this exact image was first seen (ms). */
export function storedThumbnailSeenAt(seen, sn, jpeg) {
  let entry = seen.get(sn);
  if (!entry?.jpeg.equals(jpeg)) seen.set(sn, (entry = { jpeg, at: Date.now() }));
  return entry.at;
}
