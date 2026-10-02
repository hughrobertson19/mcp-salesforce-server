import { describe, expect, it, vi } from 'vitest';
import { createSalesforceClient, SalesforceApiError } from './sfClient.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchImpl: typeof fetch) {
  return createSalesforceClient({
    loginUrl: 'https://login.example',
    clientId: 'id',
    clientSecret: 'secret',
    apiVersion: '61.0',
    fetchImpl,
  });
}

describe('createSalesforceClient', () => {
  it('authenticates once and reuses the cached token across calls', async () => {
    let authCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.endsWith('/services/oauth2/token')) {
        authCalls += 1;
        return jsonResponse(200, { access_token: 'tok-1', instance_url: 'https://instance.example' });
      }
      return jsonResponse(200, { Id: '003ABC', Email: 'a@example.com' });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getRecordFields('Contact', '003ABC', ['Email']);
    await client.getRecordFields('Contact', '003ABC', ['Email']);

    expect(authCalls).toBe(1);
  });

  it('retries exactly once after a fresh auth when a data call returns 401', async () => {
    let authCalls = 0;
    let dataCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.endsWith('/services/oauth2/token')) {
        authCalls += 1;
        return jsonResponse(200, { access_token: `tok-${authCalls}`, instance_url: 'https://instance.example' });
      }
      dataCalls += 1;
      if (dataCalls === 1) {
        return jsonResponse(401, { message: 'session expired' });
      }
      return jsonResponse(200, { Id: '003ABC', Email: 'a@example.com' });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const contact = await client.getRecordFields('Contact', '003ABC', ['Email']);

    expect(contact.Email).toBe('a@example.com');
    expect(authCalls).toBe(2);
    expect(dataCalls).toBe(2);
  });

  it('getRecordFields hits the record-by-id endpoint with a fields query param', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.endsWith('/services/oauth2/token')) {
        return jsonResponse(200, { access_token: 'tok', instance_url: 'https://instance.example' });
      }
      requestedUrls.push(u);
      return jsonResponse(200, { Id: '003ABC' });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getRecordFields('Contact', '003ABC', ['Email', 'Phone']);

    expect(requestedUrls).toEqual(['https://instance.example/services/data/v61.0/sobjects/Contact/003ABC?fields=Email,Phone']);
  });

  it('builds the sobject path from the object name for Account and Opportunity', async () => {
    const requests: { url: string; method: string | undefined }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.endsWith('/services/oauth2/token')) {
        return jsonResponse(200, { access_token: 'tok', instance_url: 'https://instance.example' });
      }
      requests.push({ url: u, method: init?.method });
      return init?.method === 'PATCH' ? new Response(null, { status: 204 }) : jsonResponse(200, { Id: 'x' });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getRecordFields('Account', '001ABC', ['Website']);
    await client.patchRecord('Opportunity', '006ABC', { Amount: 75000 });

    expect(requests).toEqual([
      { url: 'https://instance.example/services/data/v61.0/sobjects/Account/001ABC?fields=Website', method: undefined },
      { url: 'https://instance.example/services/data/v61.0/sobjects/Opportunity/006ABC', method: 'PATCH' },
    ]);
  });

  it('patchRecord sends a PATCH with a JSON body of the changed fields', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.endsWith('/services/oauth2/token')) {
        return jsonResponse(200, { access_token: 'tok', instance_url: 'https://instance.example' });
      }
      capturedInit = init;
      return new Response(null, { status: 204 });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.patchRecord('Contact', '003ABC', { Email: 'new@example.com' });

    expect(capturedInit?.method).toBe('PATCH');
    expect(capturedInit?.body).toBe(JSON.stringify({ Email: 'new@example.com' }));
  });

  it('wraps a network failure in a SalesforceApiError with status undefined', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.endsWith('/services/oauth2/token')) {
        return jsonResponse(200, { access_token: 'tok', instance_url: 'https://instance.example' });
      }
      throw new TypeError('network down');
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getRecordFields('Contact', '003ABC', ['Email'])).rejects.toBeInstanceOf(SalesforceApiError);
    await expect(client.getRecordFields('Contact', '003ABC', ['Email'])).rejects.toMatchObject({ status: undefined });
  });

  it('wraps a non-2xx response in a SalesforceApiError carrying the status code', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.endsWith('/services/oauth2/token')) {
        return jsonResponse(200, { access_token: 'tok', instance_url: 'https://instance.example' });
      }
      return jsonResponse(404, { message: 'not found' });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getRecordFields('Contact', '003ABC', ['Email'])).rejects.toMatchObject({ status: 404 });
  });
});
