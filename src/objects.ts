import { z } from 'zod';

/** The Salesforce objects this server can read and (through the guard) write. */
export const SOBJECT_NAMES = ['Contact', 'Account', 'Opportunity'] as const;

export type SObjectName = (typeof SOBJECT_NAMES)[number];

export interface ObjectSpec {
  /**
   * Salesforce's standard 3-character key prefix for this object's record Ids. Checked at both
   * propose and confirm time so a proposal can never pair one object's endpoint with another
   * object's record.
   */
  idPrefix: string;
  /** Fields returned by the list/get read tools. */
  readFields: readonly string[];
  /** Fields a list tool's free-text search is matched against. */
  searchFields: readonly string[];
  /**
   * The write allowlist: the only fields propose_update will accept for this object, each with
   * the validator its proposed value must pass. Anything not listed here is rejected at propose
   * time, and re-checked against a stored proposal at confirm time.
   */
  writable: Readonly<Record<string, z.ZodType>>;
}

const nonEmpty = z.string().min(1);

/** Single source of truth for per-object read fields and the per-object write allowlist. */
export const OBJECTS: Readonly<Record<SObjectName, ObjectSpec>> = {
  Contact: {
    idPrefix: '003',
    readFields: ['Id', 'Name', 'Email', 'Phone', 'Title', 'Department'],
    searchFields: ['Name', 'Email'],
    writable: {
      Email: z.email(),
      Phone: nonEmpty,
      Title: nonEmpty,
      Department: nonEmpty,
    },
  },
  Account: {
    idPrefix: '001',
    readFields: ['Id', 'Name', 'Phone', 'Website', 'Industry'],
    searchFields: ['Name', 'Website'],
    writable: {
      Phone: nonEmpty,
      Website: nonEmpty,
      Industry: nonEmpty,
    },
  },
  Opportunity: {
    idPrefix: '006',
    readFields: ['Id', 'Name', 'AccountId', 'StageName', 'CloseDate', 'Amount', 'NextStep'],
    searchFields: ['Name'],
    writable: {
      // Picklist validity (which stages exist in this org) is left to Salesforce, which rejects an
      // unknown value with a 400 — surfaced as write_failed, never retried.
      StageName: nonEmpty,
      // Salesforce's REST API reads and writes dates as YYYY-MM-DD.
      CloseDate: z.iso.date(),
      NextStep: nonEmpty,
      // A JSON number, compared as a number at confirm time (zod rejects NaN/Infinity).
      Amount: z.number(),
    },
  },
};

export function isSObjectName(value: unknown): value is SObjectName {
  return typeof value === 'string' && (SOBJECT_NAMES as readonly string[]).includes(value);
}

export function writableFields(object: SObjectName): string[] {
  return Object.keys(OBJECTS[object].writable);
}

/** Own-property check, so inherited keys like `constructor` or `toString` are never "allowlisted". */
export function isWritableField(object: SObjectName, field: string): boolean {
  return Object.hasOwn(OBJECTS[object].writable, field);
}

export function hasIdPrefixFor(object: SObjectName, recordId: string): boolean {
  return recordId.startsWith(OBJECTS[object].idPrefix);
}
