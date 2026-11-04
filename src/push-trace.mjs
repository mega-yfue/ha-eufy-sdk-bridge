// A debug trace of every push the SDK normalised, whether or not a capability turned it into an event. It
// names the push's fields, never their values: a push the SDK can't map (it decodes to no event and the
// bridge never hears of it) can then be described from a user's log without anyone sharing its contents.

/**
 * One line describing a normalised push: its event type and name, its device, and the sorted names of the
 * fields on its deepest payload level. Values are left out, since they can carry names, ids and URLs.
 */
export function pushFieldSummary(ev) {
  const fields = Object.keys(ev?.payload ?? {}).sort();
  return (
    `push raw: eventType=${ev?.eventType ?? "?"}${ev?.eventName ? ` (${ev.eventName})` : ""}` +
    ` sn=${ev?.deviceSn ?? "?"} fields=[${fields.join(",")}]`
  );
}
