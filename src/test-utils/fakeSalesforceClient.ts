import { SOBJECT_NAMES, type SObjectName } from '../objects.js';
import { SalesforceApiError, type SalesforceClient } from '../sfClient.js';
import type { FieldValue, SalesforceRecord } from '../types.js';

/** Initial "live" records, keyed by object, then by record Id. */
export type FakeRecords = Partial<Record<SObjectName, Record<string, SalesforceRecord>>>;

export interface FakeSalesforceClient extends SalesforceClient {
  /** Simulates a concurrent Salesforce edit — mutate the "live" record between propose and confirm. */
  setField(object: SObjectName, recordId: string, field: string, value: FieldValue): void;
  /** Reads the current "live" record, for asserting what a write did (or didn't) change. */
  getRecord(object: SObjectName, recordId: string): SalesforceRecord | undefined;
  /**
   * Queues failures for upcoming patchRecord calls, one status per call.
   * `undefined` simulates a network failure (no response); a number simulates that HTTP status.
   * Once the queue is empty, patchRecord succeeds normally again.
   */
  failNextPatchCalls(statuses: ReadonlyArray<number | undefined>): void;
  /** Total patchRecord calls across every object. */
  patchCallCount: number;
  /** patchRecord calls per object — proves a write landed on the object it was proposed for. */
  patchCalls: Record<SObjectName, number>;
  /** getRecordFields calls per object. */
  getCalls: Record<SObjectName, number>;
}

function zeroCounts(): Record<SObjectName, number> {
  return Object.fromEntries(SOBJECT_NAMES.map((name) => [name, 0])) as Record<SObjectName, number>;
}

export function createFakeSalesforceClient(initial: FakeRecords): FakeSalesforceClient {
  // Each object gets its own store, exactly like separate sobject endpoints.
  const stores = new Map<SObjectName, Map<string, SalesforceRecord>>(
    SOBJECT_NAMES.map((name) => [
      name,
      new Map(Object.entries(initial[name] ?? {}).map(([id, record]) => [id, { ...record }])),
    ]),
  );
  const pendingFailures: Array<number | undefined> = [];

  function storeFor(object: SObjectName): Map<string, SalesforceRecord> {
    const store = stores.get(object);
    if (!store) {
      throw new Error(`Unknown object: ${object}`);
    }
    return store;
  }

  const client: FakeSalesforceClient = {
    patchCallCount: 0,
    patchCalls: zeroCounts(),
    getCalls: zeroCounts(),

    async query(soql) {
      const from = /\bFROM\s+(\w+)/i.exec(soql)?.[1];
      const store = SOBJECT_NAMES.find((name) => name === from);
      return store ? ([...storeFor(store).values()] as Record<string, unknown>[]) : [];
    },

    async getRecordFields(object, id, fields) {
      client.getCalls[object] += 1;
      const record = storeFor(object).get(id);
      if (!record) {
        throw new SalesforceApiError(`No such ${object}: ${id}`, 404);
      }
      const result: SalesforceRecord = { Id: record.Id };
      for (const field of fields) {
        if (field === 'Id') continue;
        result[field] = record[field] ?? null;
      }
      return result;
    },

    async patchRecord(object, id, fields) {
      client.patchCallCount += 1;
      client.patchCalls[object] += 1;
      if (pendingFailures.length > 0) {
        const status = pendingFailures.shift();
        throw new SalesforceApiError(`Simulated patchRecord failure (status ${String(status)})`, status);
      }
      const record = storeFor(object).get(id);
      if (!record) {
        throw new SalesforceApiError(`No such ${object}: ${id}`, 404);
      }
      Object.assign(record, fields);
    },

    setField(object, recordId, field, value) {
      const record = storeFor(object).get(recordId);
      if (!record) {
        throw new Error(`No such ${object}: ${recordId}`);
      }
      record[field] = value;
    },

    getRecord(object, recordId) {
      const record = storeFor(object).get(recordId);
      return record ? { ...record } : undefined;
    },

    failNextPatchCalls(statuses) {
      pendingFailures.push(...statuses);
    },
  };

  return client;
}
