/**
 * Re-send a guard-mode write that no station confirmed.
 *
 * `setProperty(sn, "armingMode", v)` resolves once the command is SENT, not once the station applied it.
 * A fresh P2P session that answers nothing (eufy-sdk #585), or a standalone station on level-1 only, can
 * swallow the write while the bridge reports OK; the caller then sees the old mode until someone retries
 * by hand. A write is therefore held until the station is seen in the requested mode, and re-sent up to
 * `retries` times, each after `timeoutMs` of silence. The re-send rides the session the first write
 * opened, which by then has answered.
 *
 * The hold is value-aware, because this writes arming state and the station can also change mode on its
 * own (keypad, the eufy app, a schedule, a geofence):
 *
 * - `armingModeChanged` carries no value, so on that event the mode is read back. The requested mode
 *   confirms the write; a third mode (neither requested nor pre-write) means someone else moved the
 *   station after us, and that change wins: the hold is dropped with no re-send. A readback still on
 *   the pre-write mode (or unreadable) has not converged yet, and the event counts as our confirmation.
 * - Before a re-send the mode is read back too. Already the requested mode → confirmed, nothing sent.
 *   Different from the mode the station had when we wrote → changed out of band, dropped. Only a station
 *   still in its pre-write mode is re-sent the write, so a stale value never overrides a newer change.
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

export function createArmingConfirm({
  eufy,
  log = () => {},
  timeoutMs = 12_000,
  retries = 2,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  // The station's current guard mode as a wire integer, or `undefined` when it cannot be read.
  readMode = async (sn) => {
    try {
      const dev = await eufy.getDevice?.(sn);
      return armingWire(dev?.getProperties?.()?.armingMode?.value);
    } catch {
      return undefined;
    }
  },
}) {
  const pending = new Map(); // sn → { value, want, before, tries, timer }

  const arm = (sn, entry) => {
    clearTimer(entry.timer);
    entry.timer = setTimer(() => void expire(sn, entry), timeoutMs);
    entry.timer?.unref?.();
  };

  const drop = (sn, entry) => {
    clearTimer(entry.timer);
    if (pending.get(sn) === entry) pending.delete(sn);
  };

  async function expire(sn, entry) {
    if (pending.get(sn) !== entry) return;
    const [before, now] = await Promise.all([entry.before, readMode(sn)]);
    if (pending.get(sn) !== entry) return; // replaced or settled while reading
    if (now !== undefined && now === entry.want) {
      drop(sn, entry);
      log(`arming confirmed by readback sn=${sn} value=${entry.value}`);
      return;
    }
    if (now !== before) {
      drop(sn, entry);
      log(`arming changed out of band sn=${sn} (${before} → ${now}), not re-sending value=${entry.value}`);
      return;
    }
    if (entry.tries >= retries) {
      drop(sn, entry);
      log(`arming NOT confirmed sn=${sn} value=${entry.value} after ${entry.tries} re-send(s)`);
      return;
    }
    entry.tries += 1;
    log(`arming not confirmed in ${timeoutMs}ms sn=${sn} value=${entry.value} → re-send ${entry.tries}/${retries}`);
    arm(sn, entry); // armed before the send: a confirmation can beat setProperty's own resolve
    try {
      await eufy.setProperty(sn, "armingMode", entry.value);
    } catch (e) {
      log(`arming re-send failed sn=${sn}: ${e?.message ?? e}`);
    }
  }

  eufy.on?.("armingModeChanged", async (payload) => {
    const sn = payload?.deviceSn;
    const entry = pending.get(sn);
    if (!entry) return;
    clearTimer(entry.timer); // no re-send fires while the mode is read back
    const [before, now] = await Promise.all([entry.before, readMode(sn)]);
    if (pending.get(sn) !== entry) return;
    drop(sn, entry);
    if (now !== undefined && now === entry.want) {
      if (entry.tries) log(`arming confirmed sn=${sn} after ${entry.tries} re-send(s)`);
    } else if (now === undefined || now === before) {
      // The station reported a change but the readback has not converged yet: the only change known
      // is ours, so the event confirms it.
      log(`arming confirmed sn=${sn} by event (readback not converged: ${now})`);
    } else {
      log(`arming changed to ${now} sn=${sn}, not the requested value=${entry.value}: left as the station set it`);
    }
  });

  return {
    /** Call before a write is sent: an `armingMode` write is then held until its station confirms it. */
    sending(sn, name, value) {
      if (name !== "armingMode") return;
      const old = pending.get(sn);
      if (old) clearTimer(old.timer);
      // A newer write keeps the mode the station had before the first one, so its own re-send is not
      // mistaken for an out-of-band change.
      const before = old ? old.before : readMode(sn);
      const entry = { value, want: armingWire(value), before, tries: 0, timer: undefined };
      pending.set(sn, entry);
      arm(sn, entry);
    },
    /** The write itself failed: the caller sees the error, so nothing is held for it. */
    failed(sn, name) {
      if (name !== "armingMode") return;
      const entry = pending.get(sn);
      if (entry) drop(sn, entry);
    },
    pendingCount: () => pending.size,
  };
}
