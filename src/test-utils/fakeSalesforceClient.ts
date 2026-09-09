import { SalesforceApiError, type SalesforceClient } from '../sfClient.js';
import type { Contact, WritableContactField } from '../types.js';

export interface FakeSalesforceClient extends SalesforceClient {
  /** Simulates a concurrent Salesforce edit — mutate the "live" record between propose and confirm. */
  setField(contactId: string, field: WritableContactField, value: string | null): void;
  /**
   * Queues failures for upcoming patchContact calls, one status per call.
   * `undefined` simulates a network failure (no response); a number simulates that HTTP status.
   * Once the queue is empty, patchContact succeeds normally again.
   */
  failNextPatchCalls(statuses: ReadonlyArray<number | undefined>): void;
  patchCallCount: number;
}

export function createFakeSalesforceClient(initial: Record<string, Contact>): FakeSalesforceClient {
  const records = new Map<string, Contact>(Object.entries(initial).map(([id, contact]) => [id, { ...contact }]));
  const pendingFailures: Array<number | undefined> = [];

  const client: FakeSalesforceClient = {
    patchCallCount: 0,

    async query() {
      return [...records.values()] as unknown as Record<string, unknown>[];
    },

    async getContactFields(id, fields) {
      const record = records.get(id);
      if (!record) {
        throw new SalesforceApiError(`No such contact: ${id}`, 404);
      }
      const result: Contact = { Id: record.Id };
      for (const field of fields as readonly WritableContactField[]) {
        result[field] = record[field] ?? null;
      }
      return result;
    },

    async patchContact(id, fields) {
      client.patchCallCount += 1;
      if (pendingFailures.length > 0) {
        const status = pendingFailures.shift();
        throw new SalesforceApiError(`Simulated patchContact failure (status ${String(status)})`, status);
      }
      const record = records.get(id);
      if (!record) {
        throw new SalesforceApiError(`No such contact: ${id}`, 404);
      }
      Object.assign(record, fields);
    },

    setField(contactId, field, value) {
      const record = records.get(contactId);
      if (!record) {
        throw new Error(`No such contact: ${contactId}`);
      }
      record[field] = value;
    },

    failNextPatchCalls(statuses) {
      pendingFailures.push(...statuses);
    },
  };

  return client;
}
