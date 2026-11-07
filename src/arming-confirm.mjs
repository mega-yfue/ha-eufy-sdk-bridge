/**
 * Re-send a guard-mode write that no station confirmed.
 *
 * `setProperty(sn, "armingMode", v)` resolves once the command is SENT, not once the station applied it.
 * A fresh P2P session that answers nothing (eufy-sdk #585), or a standalone station on level-1 only, can
 * swallow the write while the bridge reports OK; the caller then sees the old mode until someone retries
 * by hand. A station that applies a mode change says so with `armingModeChanged`, so a write not followed
 * by one within `timeoutMs` is re-sent, up to `retries` times. The re-send rides the session the first
 * write opened, which by then has answered. Re-sending a mode the station did apply is harmless: it is
 * the same mode.
 */
export function createArmingConfirm({
  eufy,
  log = () => {},
  timeoutMs = 12_000,
  retries = 2,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const pending = new Map(); // sn → { value, tries, timer }

  const arm = (sn, entry) => {
    clearTimer(entry.timer);
    entry.timer = setTimer(() => void expire(sn, entry), timeoutMs);
    entry.timer?.unref?.();
  };

  async function expire(sn, entry) {
    if (pending.get(sn) !== entry) return;
    if (entry.tries >= retries) {
      pending.delete(sn);
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

  eufy.on?.("armingModeChanged", (payload) => {
    const sn = payload?.deviceSn;
    const entry = pending.get(sn);
    if (!entry) return;
    clearTimer(entry.timer);
    pending.delete(sn);
    if (entry.tries) log(`arming confirmed sn=${sn} after ${entry.tries} re-send(s)`);
  });

  return {
    /** Call before a write is sent: an `armingMode` write is then held until its station confirms it. */
    sending(sn, name, value) {
      if (name !== "armingMode") return;
      const old = pending.get(sn);
      if (old) clearTimer(old.timer);
      const entry = { value, tries: 0, timer: undefined };
      pending.set(sn, entry);
      arm(sn, entry);
    },
    /** The write itself failed: the caller sees the error, so nothing is held for it. */
    failed(sn, name) {
      if (name !== "armingMode") return;
      const entry = pending.get(sn);
      if (entry) clearTimer(entry.timer);
      pending.delete(sn);
    },
    pendingCount: () => pending.size,
  };
}
