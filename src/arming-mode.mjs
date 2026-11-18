/**
 * The station's guard mode on the `armingModeChanged` event the bridge forwards.
 *
 * The SDK emits `armingModeChanged` with no value: the MODE_SWITCH push names no mode, so the SDK re-reads
 * the mode and emits the bare transition once that re-read has landed on the device it hands out. The
 * bridge holds that device (see `memoizeGetDevice`), so by the time the event reaches us its `armingMode`
 * property is the mode the station switched to. Reading it there and adding it as `mode` saves every
 * client a `device.state` round-trip, and gives a client with no re-read of its own a value at all.
 */

/** `ArmingMode` names → wire integers (eufy-sdk `ARMING_MODE_WIRE`); the getter answers the integer. */
const WIRE = { away: 0, home: 1, schedule: 2, custom1: 3, custom2: 4, custom3: 5, off: 6, geo: 47, disarmed: 63 };

/** A mode in either vocabulary as its wire integer, or `undefined` when it is not a known mode. */
export function armingWire(v) {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    if (v in WIRE) return WIRE[v];
    if (/^\d+$/.test(v)) return Number(v);
  }
  return undefined;
}

/**
 * The event payload with `mode` (the wire integer, as `device.state` reports `armingMode`) added when the
 * station's mode can be read. Otherwise the payload unchanged, so a client falls back to re-reading state,
 * as it must today. Never throws.
 */
export async function withArmingMode(eufy, payload) {
  const sn = payload?.deviceSn;
  if (!sn) return payload;
  try {
    const dev = await eufy.getDevice(sn);
    const mode = armingWire(dev?.getProperties?.()?.armingMode?.value);
    return mode === undefined ? payload : { ...payload, mode };
  } catch {
    return payload;
  }
}
