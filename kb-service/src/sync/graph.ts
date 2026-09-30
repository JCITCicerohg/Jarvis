export interface GraphItem {
  id: string; name?: string; parentReference?: { id?: string; path?: string };
  file?: { mimeType?: string }; folder?: unknown; deleted?: unknown; size?: number; webUrl?: string;
  eTag?: string; cTag?: string; lastModifiedDateTime?: string; '@microsoft.graph.downloadUrl'?: string;
}
export interface DeltaPage { value: GraphItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }
export interface GraphLike {
  delta(url: string): Promise<DeltaPage>;
  download(driveId: string, item: GraphItem): Promise<Buffer>;
}

export class GraphError extends Error {
  constructor(public status: number, message: string) { super(`Graph ${status}: ${message}`); }
}

/** App-only Graph client (client credentials). Read-only: delta and file download. */
export class GraphClient implements GraphLike {
  private token: { value: string; expires: number } | null = null;
  constructor(private cfg: { tenantId: string; clientId: string; clientSecret: string }, private fetchImpl: typeof fetch = fetch) {}

  private async bearer(): Promise<string> {
    if (this.token && Date.now() < this.token.expires - 60_000) return this.token.value;
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    if (!res.ok) throw new GraphError(res.status, `token request failed: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    return this.token.value;
  }

  private async get(url: string, attempt = 0): Promise<Response> {
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${await this.bearer()}` } });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get('retry-after') ?? 2 ** attempt) * 1000;
      await new Promise(r => setTimeout(r, wait));
      return this.get(url, attempt + 1);
    }
    return res;
  }

  async delta(url: string): Promise<DeltaPage> {
    const res = await this.get(url);
    if (!res.ok) throw new GraphError(res.status, (await res.text()).slice(0, 300));
    return (await res.json()) as DeltaPage;
  }

  async download(driveId: string, item: GraphItem): Promise<Buffer> {
    const direct = item['@microsoft.graph.downloadUrl'];
    const res = direct ? await this.fetchImpl(direct) : await this.get(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${item.id}/content`);
    if (!res.ok) throw new GraphError(res.status, `download of ${item.name ?? item.id} failed`);
    return Buffer.from(await res.arrayBuffer());
  }
}
