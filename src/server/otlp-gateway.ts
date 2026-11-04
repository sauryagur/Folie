// OTLP/HTTP pass-through. Sandboxed agents never talk to a collector: like everything else they send
// telemetry to folie-server, which forwards it verbatim. Agents therefore need no collector address or
// credentials, and the sole-writer rule (one trust path out of the sandbox) holds for telemetry too.

export type OtlpSignal = "traces" | "metrics" | "logs";

/** Where agents post each signal on folie-server. */
export const OTLP_SIGNAL_PATH: Record<string, OtlpSignal> = {
  "/v1/otlp/v1/traces": "traces",
  "/v1/otlp/v1/metrics": "metrics",
  "/v1/otlp/v1/logs": "logs",
};

export interface OtlpGateway {
  /** Returns the HTTP status to answer the agent with. Never throws: telemetry must not break a session. */
  forward(signal: OtlpSignal, body: Uint8Array, headers: { contentType: string; contentEncoding?: string }): Promise<number>;
}

export function otlpGateway(endpoint: string | undefined, fetchFn: typeof fetch = fetch): OtlpGateway {
  return {
    async forward(signal, body, { contentType, contentEncoding }) {
      // No collector configured: accept and drop, so agents do not retry or log errors for a feature that is off.
      if (!endpoint) return 202;
      try {
        const res = await fetchFn(`${endpoint}/v1/${signal}`, {
          method: "POST",
          headers: { "content-type": contentType, ...(contentEncoding ? { "content-encoding": contentEncoding } : {}) },
          body: body as Uint8Array<ArrayBuffer>,
        });
        return res.status;
      } catch {
        return 502; // the exporter's own retry policy decides what to do with a bad gateway
      }
    },
  };
}
