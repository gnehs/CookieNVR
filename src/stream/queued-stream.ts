/**
 * A response body whose queue length is the client's backlog: Bun pulls from it only as fast as the
 * socket drains, so `backlog()` tells how far behind a slow reader is.
 */
export function queuedStream(maxBacklog: number, onCancel: () => void) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        ctl = c;
      },
      cancel() {
        open = false;
        onCancel();
      },
    },
    { highWaterMark: maxBacklog, size: (chunk) => chunk?.byteLength ?? 0 },
  );
  return {
    stream,
    get open() {
      return open;
    },
    enqueue(bytes: Uint8Array) {
      if (open) ctl.enqueue(bytes);
    },
    backlog: () => (open ? maxBacklog - (ctl.desiredSize ?? 0) : 0),
    /** Drops whatever is still queued; the client sees the response end early and reconnects. */
    abort() {
      if (!open) return;
      open = false;
      // Without a reason Bun aborts the connection without logging a stack trace.
      ctl.error();
      onCancel();
    },
  };
}
