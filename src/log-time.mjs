// Prefix every console line with the local time of day. Home Assistant's add-on log shows no timestamps, so
// a pasted log could not be lined up with what the user saw (or with go2rtc's own lines, which carry UTC).
// Opt-in via LOG_TIMESTAMPS: `docker logs -t` already stamps lines for container users.

const INSTALLED = Symbol.for("eufy-bridge.console-timestamps");

/** `HH:MM:SS.mmm` in the process's local time zone (TZ). */
export function timeOfDay(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Route console output through a time-of-day prefix. Installing twice is a no-op. */
export function installConsoleTimestamps(target = console, now = () => new Date()) {
  if (target[INSTALLED]) return;
  target[INSTALLED] = true;
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = target[method].bind(target);
    target[method] = (...args) => original(timeOfDay(now()), ...args);
  }
}
