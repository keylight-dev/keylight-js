export type TransportOutcome =
  | { kind: "response"; status: number; body: string; retryAfter?: number }
  | { kind: "transient"; error: string }
  | { kind: "terminal"; error: string }
  | { kind: "timeout" };

export type Header = [string, string];

export interface Transport {
  postJson(url: string, headers: Header[], body: string): Promise<TransportOutcome>;
  get(url: string, headers: Header[]): Promise<TransportOutcome>;
}

/** Default transport over the Web `fetch` API (universal). */
export class FetchTransport implements Transport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async run(url: string, init: RequestInit): Promise<TransportOutcome> {
    try {
      const res = await this.fetchImpl(url, init);
      const body = await res.text();
      // Retry-After: numeric seconds (incl. 0) is honored; the HTTP-date form is
      // not parsed and yields undefined (caller falls back to default backoff).
      const raw = res.headers.get("retry-after");
      let retryAfter: number | undefined;
      if (raw != null) {
        const n = Number(raw);
        retryAfter = Number.isFinite(n) ? n : undefined;
      }
      return { kind: "response", status: res.status, body, retryAfter };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // AbortError = our timeout signal. TypeError from fetch = permanent
      // (bad URL / malformed request), so it is terminal, not a retryable blip.
      // Everything else (connection reset, DNS, etc.) is transient and retryable.
      if (e instanceof Error && e.name === "AbortError") return { kind: "timeout" };
      if (e instanceof TypeError) return { kind: "terminal", error: msg };
      return { kind: "transient", error: msg };
    }
  }

  // NOTE: callers must not pass a duplicate "content-type" header; it would
  // override the JSON encoding this method sets.
  postJson(url: string, headers: Header[], body: string) {
    return this.run(url, { method: "POST", headers: [["content-type", "application/json"], ...headers], body });
  }

  get(url: string, headers: Header[]) {
    return this.run(url, { method: "GET", headers });
  }
}
