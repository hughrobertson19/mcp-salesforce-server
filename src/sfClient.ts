import type { SObjectName } from './objects.js';
import type { SalesforceRecord } from './types.js';

/**
 * Every SalesforceClient method throws this on failure. `status` is the HTTP status code for a
 * non-2xx response, or `undefined` for a genuine network failure (no response received at all).
 * Callers that need to decide whether a failure is worth retrying (see guard.ts) classify on
 * this single field instead of distinguishing raw fetch exceptions from HTTP-level failures.
 */
export class SalesforceApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'SalesforceApiError';
  }
}

/**
 * Escapes a value for safe interpolation into a SOQL `LIKE '%...%'` clause.
 * The only place free-text user input reaches a query string in this project
 * (the list tools' search term) — getRecordFields/patchRecord only ever use object
 * and field names drawn from the fixed OBJECTS config in objects.ts.
 */
export function escapeSoqlLikeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export interface SalesforceClient {
  query(soql: string): Promise<Record<string, unknown>[]>;
  /** `object` is always one of the fixed OBJECTS keys, never free text from a caller. */
  getRecordFields(object: SObjectName, id: string, fields: readonly string[]): Promise<SalesforceRecord>;
  patchRecord(object: SObjectName, id: string, fields: Record<string, string | number>): Promise<void>;
}

export interface SalesforceClientOptions {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  /** Injection point for tests — avoids mocking the global fetch. */
  fetchImpl?: typeof fetch;
}

interface TokenState {
  accessToken: string;
  instanceUrl: string;
}

export function createSalesforceClient(opts: SalesforceClientOptions): SalesforceClient {
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Salesforce's client-credentials token endpoint doesn't reliably return a usable
  // expires_in, so this cache is reactive rather than TTL-based: hold the token
  // indefinitely and only discard it when a request actually comes back 401.
  let cachedToken: TokenState | null = null;

  async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      throw new SalesforceApiError(
        `Salesforce request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SalesforceApiError(`Salesforce API error ${response.status} for ${url}: ${body}`, response.status);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async function authenticate(): Promise<TokenState> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    });
    const data = await requestJson<{ access_token: string; instance_url: string }>(
      `${opts.loginUrl}/services/oauth2/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
    );
    return { accessToken: data.access_token, instanceUrl: data.instance_url };
  }

  async function ensureToken(): Promise<TokenState> {
    cachedToken ??= await authenticate();
    return cachedToken;
  }

  /** One authenticated call, retrying exactly once after a fresh auth if the first attempt is a 401. */
  async function authedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const attempt = async (): Promise<T> => {
      const { accessToken, instanceUrl } = await ensureToken();
      return requestJson<T>(`${instanceUrl}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
      });
    };

    try {
      return await attempt();
    } catch (err) {
      if (err instanceof SalesforceApiError && err.status === 401) {
        cachedToken = null;
        return await attempt();
      }
      throw err;
    }
  }

  return {
    async query(soql) {
      const path = `/services/data/v${opts.apiVersion}/query/?q=${encodeURIComponent(soql)}`;
      const data = await authedRequest<{ records: Record<string, unknown>[] }>(path);
      return data.records;
    },

    async getRecordFields(object, id, fields) {
      const path = `/services/data/v${opts.apiVersion}/sobjects/${object}/${encodeURIComponent(id)}?fields=${fields.join(',')}`;
      return authedRequest<SalesforceRecord>(path);
    },

    async patchRecord(object, id, fields) {
      const path = `/services/data/v${opts.apiVersion}/sobjects/${object}/${encodeURIComponent(id)}`;
      await authedRequest<void>(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
    },
  };
}
