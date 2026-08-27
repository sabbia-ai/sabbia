import { acquireStream } from "./limits";
import { events, type JournalEvent } from "./db";

type Listener = (event: JournalEvent) => void;
const listeners = new Map<string, Set<Listener>>();
const connections = new Set<() => void>();
const encoder = new TextEncoder();
export const encodeEvent = (event: JournalEvent) => encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
export function journal(thread: string, kind: string, payload: Record<string, unknown> = {}) {
  const event = events.append(thread, kind, payload);
  for (const listener of listeners.get(thread) ?? []) listener(event);
  return event;
}
export function eventStream(thread: string, after: number, signal: AbortSignal, live = true, run?: () => Promise<void>) {
  const release = acquireStream();
  let cleanup = release;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const finish = () => { if (!closed) { closed = true; cleanup(); try { controller.close(); } catch { /* Consumer already disconnected. */ } } };
      connections.add(finish);
      const send: Listener = event => { if (!closed) { try { if ((controller.desiredSize ?? 0) <= 0) { finish(); return; } controller.enqueue(encodeEvent(event)); } catch { finish(); } } };
      const set = listeners.get(thread) ?? new Set<Listener>();
      listeners.set(thread, set); set.add(send);
      const heartbeat = setInterval(() => { if (!closed) { try { controller.enqueue(encoder.encode(":hb\n\n")); } catch { finish(); } } }, 15000);
      const expiry = setTimeout(finish, 300000); expiry.unref(); heartbeat.unref();
      cleanup = () => { release(); connections.delete(finish); clearTimeout(expiry); clearInterval(heartbeat); set.delete(send); if (!set.size) listeners.delete(thread); signal.removeEventListener("abort", finish); };
      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      // Subscription and replay are synchronous: no gap can lose a committed event.
      for (const event of events.after(thread, after)) { if (closed) break; send(event); }
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
      if (run) void run().catch(() => {}).finally(() => { if (!live) finish(); });
    }, cancel() { cleanup(); },
  }, { highWaterMark: 1048576, size: chunk => chunk?.byteLength ?? 0 });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "connection": "keep-alive", "x-accel-buffering": "no" } });
}
export function closeEventStreams() { for (const close of [...connections]) close(); }

