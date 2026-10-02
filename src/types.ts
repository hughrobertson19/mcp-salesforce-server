import type { SObjectName } from './objects.js';

/**
 * A field value as Salesforce's REST API returns it: text, picklist and date fields arrive as
 * strings (dates as YYYY-MM-DD), currency fields as JSON numbers, and an empty field as null.
 */
export type FieldValue = string | number | null;

/** Before/after snapshot for a single field. `before` is the raw live value at propose time. */
export interface FieldDiff {
  before: FieldValue;
  after: string | number;
}

/** A record as returned by a fields-by-id fetch: always an Id, plus whichever fields were requested. */
export type SalesforceRecord = { Id: string } & Record<string, FieldValue | undefined>;

export type Contact = {
  Id: string;
  Name?: string;
  Email?: string | null;
  Phone?: string | null;
  Title?: string | null;
  Department?: string | null;
};

export interface Proposal {
  id: string;
  object: SObjectName;
  recordId: string;
  fields: Record<string, FieldDiff>;
  createdAt: string;
  expiresAt: string;
}
