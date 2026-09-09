export const WRITABLE_CONTACT_FIELDS = ['Email', 'Phone', 'Title', 'Department'] as const;

export type WritableContactField = (typeof WRITABLE_CONTACT_FIELDS)[number];

/** Before/after snapshot for a single field, string-typed since every writable Contact field here is a string field. */
export interface FieldDiff {
  before: string | null;
  after: string;
}

export interface Contact {
  Id: string;
  Name?: string;
  Email?: string | null;
  Phone?: string | null;
  Title?: string | null;
  Department?: string | null;
}

export interface Proposal {
  id: string;
  contactId: string;
  fields: Partial<Record<WritableContactField, FieldDiff>>;
  createdAt: string;
  expiresAt: string;
}
