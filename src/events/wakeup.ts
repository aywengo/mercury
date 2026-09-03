import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, chmodSync } from 'node:fs';

/**
 * Stage 1 of docs/cross-process-event-push.md: a same-host wake-up channel from the worker to the API.
 *
 * The channel is ADVISORY. It says "run X may have new rows, look now" and nothing else. The cursor is
 * advanced only by the existing poll path after rows have actually been handed to a client, so a lost,
 * duplicated, reordered or nonsense notification can change WHEN a client is updated and never WHETHER
 * the stream is complete (P2). Every design decision below follows from taking that seriously rather
 * than asserting it.
 *
 * A stream socket, not a datagram one: Node's `dgram` has no AF_UNIX support, and the fallback people
 * reach for (UDP on loopback) would open the TCP trust boundary section 11 exists to avoid. Message
 * boundaries are irrelevant here precisely BECAUSE the reader drains by cursor, so newline-delimited
 * ids read in arbitrary chunks are a feature.
 */

/** Wire format: `<runId>:<sequence>\n`. Only the run id is used; the sequence is diagnostic. */
export function encodeWakeup(runId: string, sequence: number): string {
  return `${runId}:${sequence}\n`;
}

export interface WakeupWriterStats {
  writes: number;
  drops: number;
}

/**
 * Fire-and-forget writer used by the worker.
 *
 * The one rule that matters: this must never sit on a run's critical path. A run completing is the
 * thing the user cares about; a wake-up being delivered is a courtesy to a browser. So every failure
 * path -- connect refused, socket closed, buffer full, write error -- increments a counter and returns.
 * Nothing here throws, nothing here awaits, and the caller cannot tell the difference between
 * "delivered" and "dropped" except through the counter.
 */
export class WakeupWriter {
  private socket: Socket | null = null;
  private connecting = false;
  /**
   * True only between 'connect' and 'close'/'error'.
   *
   * This exists because Node BUFFERS writes issued to a still-connecting socket. Without this gate the
   * writer quietly queued every notification in process memory whenever the API was down -- the exact
   * opposite of the "drop, never queue" rule in section 8.2, and invisible until a test counted drops
   * with no peer present and found zero. A hint that cannot reach the wire yet is a dropped hint; the
   * poller delivers the rows anyway.
   */
  private ready = false;
  private closed = false;
  private stats: WakeupWriterStats = { writes: 0, drops: 0 };

  private readonly path: string;

  private readonly onDrops: ((total: number) => void) | null;

  constructor(path: string, onDrops?: (total: number) => void) {
    this.path = path;
    this.onDrops = onDrops ?? null;
  }

  /**
   * Best-effort notification. Synchronous, non-blocking, never throws.
   *
   * `write()` returning false means the kernel/Node buffer is full. We DROP rather than queue: a queue
   * here grows without bound whenever the API is slower than the worker, and the thing it is protecting
   * is a hint that the poller will act on within one tick anyway. Bounded memory beats a hint that
   * arrives late.
   */
  notify(runId: string, sequence: number): void {
    if (this.closed) return;
    try {
      const sock = this.ensureSocket();
      if (!sock) {
        this.dropped();
        return;
      }
      if (!this.ready || sock.writableEnded || sock.destroyed) {
        this.dropped();
        return;
      }
      const ok = sock.write(encodeWakeup(runId, sequence));
      if (ok) this.stats.writes += 1;
      else {
        // Buffer full: drop the hint, and stop holding a socket we cannot drain into.
        this.dropped();
        this.destroySocket();
      }
    } catch {
      // Any unexpected failure is still just a lost hint. Swallowing here is the design, not sloppiness;
      // the counter is what makes it observable (section 12).
      this.dropped();
    }
  }

  stats_(): WakeupWriterStats {
    return { ...this.stats };
  }

  /**
   * The worker serves NO metrics endpoint -- it has no HTTP server at all -- so a drop cannot become a
   * Prometheus counter without building one, and exporting a constant zero from the API would be worse
   * than nothing: it would look healthy. This surfaces the count where it can actually be seen, logged
   * on the leading edge and then every 1000 so a slow leak still shows up without spamming.
   */
  private dropped(): void {
    this.stats.drops += 1;
    if (!this.onDrops) return;
    if (this.stats.drops === 1 || this.stats.drops % 1000 === 0) this.onDrops(this.stats.drops);
  }

  close(): void {
    this.closed = true;
    this.destroySocket();
  }

  private destroySocket(): void {
    if (!this.socket) return;
    const s = this.socket;
    this.socket = null;
    this.connecting = false;
    try {
      s.destroy();
    } catch {
      /* already gone */
    }
  }

  private ensureSocket(): Socket | null {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return null; // do not pile up connection attempts; drop instead
    this.connecting = true;
    try {
      const s = createConnection({ path: this.path });
      // An 'error' event with no listener is an UNCAUGHT exception in Node, which would take the worker
      // and its in-flight run down over a hint to a browser. This listener is load-bearing.
      s.on('error', () => {
        this.ready = false;
        this.dropped();
        this.connecting = false;
        if (this.socket === s) this.socket = null;
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
      });
      s.on('close', () => {
        this.connecting = false;
        this.ready = false;
        if (this.socket === s) this.socket = null;
      });
      s.on('connect', () => {
        this.connecting = false;
        this.ready = true;
      });
      this.socket = s;
      return s;
    } catch {
      this.connecting = false;
      return null;
    }
  }
}

/**
 * API-side listener.
 *
 * Coalesces per run per tick: a chatty run that appends 200 events in one tick must not cause 200
 * drains. Notifications are folded into a set and applied on the next macrotask, which is also what
 * makes the ordering of arriving bytes irrelevant.
 *
 * It deliberately does NOT parse or trust the sequence, and does not touch any cursor: it calls back
 * with a run id and the poll path decides what to read.
 */
export class WakeupListener {
  private server: Server | null = null;
  private pending = new Set<string>();
  private scheduled = false;
  private received = 0;

  private readonly path: string;
  private readonly onWake: (runId: string) => void;

  constructor(path: string, onWake: (runId: string) => void) {
    this.path = path;
    this.onWake = onWake;
  }

  get wakeupsReceived(): number {
    return this.received;
  }

  async listen(): Promise<void> {
    // A socket file left by a crashed API makes bind() fail with EADDRINUSE forever. Unlinking our own
    // path first is the standard recovery and is safe because the path is ours and single-owner.
    if (existsSync(this.path)) {
      try {
        unlinkSync(this.path);
      } catch {
        /* if we cannot remove it, bind() will report the real problem */
      }
    }
    const server = createServer((sock) => this.attach(sock));
    this.server = server;
    server.on('error', () => {
      /* a listener failure must not take the API down; polling is unaffected */
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.path, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    // The socket is the only trust boundary we add, and it is a file permission: same-user only
    // (section 11). Directory mode is the deployment's business; ours is the socket itself.
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best effort; the directory is already user-owned in deploy/ */
    }
  }

  close(): void {
    this.server?.close();
    this.server = null;
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      /* already removed */
    }
  }

  private attach(sock: Socket): void {
    let buf = '';
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      // A peer that never sends a newline cannot grow our buffer without bound: cap it and drop.
      if (buf.length > 65536) buf = buf.slice(-4096);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.consume(line);
      }
    });
    sock.on('error', () => {
      /* peer restart mid-write is expected (section 10); polling covers it */
    });
  }

  private consume(line: string): void {
    // Require the defined `runId:sequence` shape. A line with no separator is not a truncated run id,
    // it is garbage, and accepting it would mean a corrupt peer could wake arbitrary ids. Harmless
    // today because an unknown id matches no subscriber, but the format is specified and the reader
    // should hold it. Never throws, never stalls the reader either way.
    const sep = line.indexOf(':');
    if (sep <= 0) return;
    const runId = line.slice(0, sep).trim();
    if (!runId) return;
    this.received += 1;
    this.pending.add(runId);
    if (this.scheduled) return;
    this.scheduled = true;
    // Coalesce on the next tick so a burst collapses into one drain per distinct run.
    setImmediate(() => {
      this.scheduled = false;
      const ids = [...this.pending];
      this.pending.clear();
      for (const id of ids) {
        try {
          this.onWake(id);
        } catch {
          /* a failed wake-up is merely a missed hint; the poll still runs */
        }
      }
    });
  }
}
