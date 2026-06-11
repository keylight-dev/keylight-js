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
      const ra = res.headers.get("retry-after");
      return { kind: "response", status: res.status, body, retryAfter: ra ? Number(ra) || undefined : undefined };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === "AbortError") return { kind: "timeout" };
      return { kind: "transient", error: msg };
    }
  }

  postJson(url: string, headers: Header[], body: string) {
    return this.run(url, { method: "POST", headers: [["content-type", "application/json"], ...headers], body });
  }

  get(url: string, headers: Header[]) {
    return this.run(url, { method: "GET", headers });
  }
}
