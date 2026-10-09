// Face-recognition name resolution. A `personDetected` push carries only a numeric `person_id`, not the
// recognised person's name — the name lives in the on-HomeBase `person_basic_info` table, which the SDK
// reads over P2P (`getStationFaces`, called at startup by warmup.mjs into `ctx.state.faceNames`). Here:
// turn one of its rows into a roster entry, and enrich a push with the resolved name. `rosterEntry` /
// `firstJsonObject` are pure and unit-tested.

/**
 * One `person_basic_info` row as a roster entry: `[person_id, { name, familiar }]`, or `undefined` for a row
 * without a usable id or name. `stranger<n>` is the station's own placeholder for an unnamed face.
 */
export function rosterEntry(row) {
  const id = Number(row?.person_id);
  const name = row?.name;
  if (!Number.isFinite(id) || typeof name !== "string") return undefined;
  return [id, { name, familiar: !/^stranger\d+$/.test(name) }];
}

/** The first complete brace-balanced JSON object in a string (the P2P DB reply has trailing padding). */
export function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Face enrichment bound to the shared roster. */
export function createFaces(ctx) {
  const { faceNames } = ctx.state;

  /**
   * Attach the recognised person's name to a `personDetected` payload.
   *
   * The push carries only `person_id`; look it up in the roster to add `person_name` + `recognized`.
   * `person_id <= 0` (or -1) means "a person, but no face match" → left unresolved (recognized:false).
   * Unmapped positive ids are logged so a first real recognition confirms the id-space live.
   */
  function enrichPersonName(event, payload) {
    if (event !== "personDetected") return payload;
    const pid = Number(payload?.person_id);
    if (!Number.isFinite(pid) || pid <= 0) return { ...payload, recognized: false };
    const rec = faceNames.get(pid);
    if (!rec) {
      console.log(`[bridge] personDetected person_id=${pid} not in roster (${faceNames.size} known)`);
      return { ...payload, recognized: false };
    }
    return { ...payload, person_name: rec.name, recognized: rec.familiar };
  }

  return { enrichPersonName };
}
