// A Session whose mid-run mail and shipped events a test controls and inspects.
import { trace, type Tracer } from "@opentelemetry/api";
import { EventSink } from "../../src/agent/events";
import type { Session } from "../../src/agent/runtime";
import type { StructuredLogger } from "../../src/shared/logger";
import type { Message, SessionEventInput } from "../../src/shared/types";

const noopLog: StructuredLogger = {
  log() {},
  error() {},
  child: () => noopLog,
};

export interface FakeSessionOptions {
  id?: string;
  scope?: string;
  /** Each takeNewMail() call returns the next batch; once exhausted it returns nothing. */
  mail?: Message[][];
  tracer?: Tracer;
}

export function fakeSession(o: FakeSessionOptions = {}) {
  const delivered: SessionEventInput[] = [];
  const events = new EventSink(
    async (e) => void delivered.push(...e),
    () => {},
  );
  const queue = [...(o.mail ?? [])];
  const session: Session = {
    id: o.id ?? "s1",
    scope: o.scope ?? "wi:1",
    workItemId: 1,
    takeNewMail: async () => queue.shift() ?? [],
    events,
    tracer: o.tracer ?? trace.getTracer("test"),
    log: noopLog,
  };
  return {
    session,
    /** Events the server has received so far (flushed). */
    delivered,
    /** Everything emitted, after a final flush. */
    all: async () => (await events.flush(), delivered),
  };
}
