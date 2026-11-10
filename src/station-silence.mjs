// Recover a station that stops answering the direct `history_record_info` read on a session that still
// reports itself connected.
//
// On a local-storage account the pushes carry no thumbnail, so "Last event" advances only through that
// read. A HomeBase 3 has been seen to stop answering it ("raw 0B received" on every read) while its P2P
// heartbeat, the push channel and /healthz all stay healthy, so every camera's "Last event" freezes until
// the bridge is restarted by hand. Closing and reopening the station's P2P session brings the answers back.
//
// So: a station that has answered at least once and then leaves `threshold` reads in a row unanswered has
// its session closed and reopened (`recycle`). If the reopened session is silent for another `threshold`
// reads, `restart` is called (the caller exits for a clean restart, as the push watchdog does). A station
// that has never answered is not counted, so a station that is down, or one that never answers this read
// (a HomeBase 2), cannot cause a restart loop. `threshold` 0 turns the guard off.
export function createStationSilenceGuard({ threshold = 3, recycle, restart, log = () => {} }) {
  const silentReads = new Map(); // stationSn -> consecutive silent reads
  const reopened = new Set(); // stations reopened since they last answered

  async function noteRead(stationSn, { answered, answeredBefore }) {
    if (!threshold || !stationSn) return; // a read made without naming its station is not counted
    if (answered) {
      silentReads.delete(stationSn);
      reopened.delete(stationSn);
      return;
    }
    if (!answeredBefore) return;
    const count = (silentReads.get(stationSn) ?? 0) + 1;
    if (count < threshold) {
      silentReads.set(stationSn, count);
      return;
    }
    silentReads.delete(stationSn);
    if (!reopened.has(stationSn)) {
      reopened.add(stationSn);
      log(
        `[bridge] station ${stationSn} stopped answering database reads (${count} in a row) - reopening its connection`,
      );
      try {
        await recycle(stationSn);
      } catch (e) {
        log(`[bridge] reopening station ${stationSn} failed: ${e?.message ?? e}`);
      }
      return;
    }
    log(`[bridge] station ${stationSn} still silent after reopening its connection - exiting for a clean restart`);
    restart();
  }

  return { noteRead };
}
