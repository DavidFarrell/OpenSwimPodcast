// SEND-button gating, extracted as a pure seam so the device-decouple rule is
// provable in a unit test rather than a DOM harness (the component runs in an
// environment:node Vitest, so a full render needs jsdom we deliberately avoid).
//
// THE RULE (device-decouple slice 5). SEND no longer depends on a device being
// mounted: the backend preps device-free then PARKS until the headphones are
// plugged in. So SEND is gated by exactly two things - both unchanged from before:
//   - downloads still in flight  (never send a half-written file)
//   - an empty queue             (nothing to send)
// `devicePath` is intentionally NOT consulted. A null device is fine; the run preps
// and waits. The device-present flow is unchanged: when downloads are terminal and
// the queue is non-empty, SEND is enabled whether or not a device is attached.

// True when SEND must stay disabled. Mirrors the old gate minus the device clause.
function sendDisabled({ downloadsPending = 0, queueLength = 0 } = {}) {
  return downloadsPending > 0 || queueLength <= 0;
}

// The SEND button label. No device-specific wording: the button always reads as
// "send" because the act is the same - the only difference is whether the transfer
// happens now (device present) or after you plug in (parked). Plain + terse, no
// marketing slickness. The "transfer on plug-in" nuance lives in the subtitle, not
// the button.
function sendLabel({ downloadsPending = 0, queueLength = 0 } = {}) {
  if (downloadsPending > 0) {
    return `WAITING FOR ${downloadsPending} DOWNLOAD${downloadsPending !== 1 ? "S" : ""}`;
  }
  if (queueLength > 0) return `SEND · ${queueLength} EP`;
  return "NOTHING LINED UP";
}

export { sendDisabled, sendLabel };
