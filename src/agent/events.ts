// Ships a session's transcript to folie-server (POST /v1/sessions/events). The agent holds no database
// credentials; this is its only way to leave a record.
import type { SessionEventInput, SessionEventType } from "../shared/types";

export type SendEvents = (events: SessionEventInput[]) => Promise<unknown>;

const BATCH = 100;
/** Under the server's per-event limit (64 KiB of JSON). */
const MAX_DATA_CHARS = 48 * 1024;
const MAX_PENDING = 10_000;

export class EventSink {
  private seq = 0;
  private pending: SessionEventInput[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly send: SendEvents,
    private readonly onError: (e: unknown) => void,
  ) {}

  emit(type: SessionEventType, data: Record<string, unknown>): void {
    if (this.pending.length >= MAX_PENDING)
      throw new Error(
        `transcript buffer full (${MAX_PENDING} events): refusing to drop silently`,
      );
    const json = JSON.stringify(data);
    const clipped =
      json.length > MAX_DATA_CHARS
        ? { truncated: true, preview: json.slice(0, MAX_DATA_CHARS / 2) }
        : data;
    this.pending.push({ seq: this.seq++, type, data: clipped });
  }

  /** Resolves once everything emitted so far was delivered. Flushes never overlap. Failed batches stay queued. */
  flush(): Promise<void> {
    this.chain = this.chain.then(async () => {
      while (this.pending.length > 0) {
        const batch = this.pending.slice(0, BATCH);
        try {
          await this.send(batch);
        } catch (e) {
          this.onError(e);
          return; // kept for the next flush; the server ignores re-sent (session, seq) pairs
        }
        this.pending.splice(0, batch.length);
      }
    });
    return this.chain;
  }
}
