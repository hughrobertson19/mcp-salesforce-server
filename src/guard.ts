import { randomUUID } from 'node:crypto';
import type { AuditLog, RecordRef, StaleFields } from './auditLog.js';
import { hasIdPrefixFor, isSObjectName, isWritableField, OBJECTS, writableFields, type SObjectName } from './objects.js';
import type { ProposalStore } from './proposalStore.js';
import { SalesforceApiError, type SalesforceClient } from './sfClient.js';
import type { FieldDiff, FieldValue } from './types.js';

export interface GuardDeps {
  sfClient: SalesforceClient;
  proposalStore: ProposalStore;
  auditLog: AuditLog;
  generateId?: () => string;
  /** Injectable so tests don't burn wall-clock time on the write retry's backoff. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Thrown by proposeUpdate when the request itself is invalid (unknown object, field outside the
 * allowlist, bad value, Id from the wrong object). Nothing is fetched, stored or logged.
 */
export class ProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalValidationError';
  }
}

export interface ProposeUpdateInput {
  /** Defaults to "Contact", so phase-0 callers that only ever sent a contactId keep working. */
  object?: SObjectName | undefined;
  recordId?: string | undefined;
  /** Phase-0 spelling of recordId, accepted for Contact only. */
  contactId?: string | undefined;
  // `| undefined` so a zod-parsed object with optional keys is assignable under exactOptionalPropertyTypes.
  changes: Record<string, string | number | undefined>;
}

export type ProposeUpdateResult = {
  proposalId: string;
  fields: Record<string, FieldDiff>;
  expiresAt: string;
} & RecordRef;

function recordRef(object: SObjectName, recordId: string): RecordRef {
  return { object, recordId, ...(object === 'Contact' ? { contactId: recordId } : {}) };
}

function resolveRecordId(object: SObjectName, input: ProposeUpdateInput): string {
  if (input.contactId !== undefined && object !== 'Contact') {
    throw new ProposalValidationError(`contactId is only valid for Contact; use recordId for ${object}.`);
  }
  if (input.recordId !== undefined && input.contactId !== undefined && input.recordId !== input.contactId) {
    throw new ProposalValidationError('recordId and contactId disagree; send only one.');
  }
  const recordId = input.recordId ?? input.contactId;
  if (recordId === undefined || recordId.length === 0) {
    throw new ProposalValidationError('propose_update requires a recordId (or contactId for a Contact).');
  }
  if (!hasIdPrefixFor(object, recordId)) {
    throw new ProposalValidationError(
      `${recordId} is not a valid ${object} Id (${object} Ids start with ${OBJECTS[object].idPrefix}).`,
    );
  }
  return recordId;
}

export async function proposeUpdate(deps: GuardDeps, input: ProposeUpdateInput): Promise<ProposeUpdateResult> {
  const object = input.object ?? 'Contact';
  if (!isSObjectName(object)) {
    throw new ProposalValidationError(`Unsupported object: ${String(object)}.`);
  }

  const changes = Object.entries(input.changes).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined,
  );
  if (changes.length === 0) {
    throw new ProposalValidationError('propose_update requires at least one field change');
  }

  const notAllowed = changes.map(([field]) => field).filter((field) => !isWritableField(object, field));
  if (notAllowed.length > 0) {
    throw new ProposalValidationError(
      `Field(s) not writable on ${object}: ${notAllowed.join(', ')}. ` +
        `Writable fields on ${object}: ${writableFields(object).join(', ')}.`,
    );
  }

  for (const [field, value] of changes) {
    const check = OBJECTS[object].writable[field]?.safeParse(value);
    if (!check?.success) {
      throw new ProposalValidationError(`Invalid value for ${object}.${field}: ${JSON.stringify(value)}.`);
    }
  }

  const recordId = resolveRecordId(object, input);
  const changedFields = changes.map(([field]) => field);
  const current = await deps.sfClient.getRecordFields(object, recordId, changedFields);

  const fields: Record<string, FieldDiff> = {};
  for (const [field, after] of changes) {
    fields[field] = { before: current[field] ?? null, after };
  }

  const generateId = deps.generateId ?? randomUUID;
  const proposal = await deps.proposalStore.create({ id: generateId(), object, recordId, fields });

  await deps.auditLog.append({
    event: 'proposed',
    timestamp: new Date().toISOString(),
    proposalId: proposal.id,
    ...recordRef(object, recordId),
    fields: proposal.fields,
  });

  return {
    proposalId: proposal.id,
    ...recordRef(object, recordId),
    fields: proposal.fields,
    expiresAt: proposal.expiresAt,
  };
}

export type ConfirmUpdateResult =
  | ({ status: 'applied'; proposalId: string; fields: Record<string, FieldDiff>; appliedAt: string } & RecordRef)
  | { status: 'rejected'; reason: 'not_found' }
  | { status: 'rejected'; reason: 'invalid_proposal' }
  | ({ status: 'rejected'; reason: 'expired' } & RecordRef)
  | ({ status: 'rejected'; reason: 'stale'; fields: StaleFields } & RecordRef)
  | ({ status: 'rejected'; reason: 'write_failed' } & RecordRef);

interface ValidProposal {
  object: SObjectName;
  recordId: string;
  fields: Record<string, FieldDiff>;
}

function isFieldValue(value: unknown): value is FieldValue {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

/**
 * Re-checks a proposal read back from the store before anything is fetched or written. The store
 * only ever holds what proposeUpdate wrote, so this is defense in depth: a corrupted or hand-edited
 * proposal file must not become a way to write a non-allowlisted field, or to point one object's
 * proposal at another object's record. A pre-multi-object file (contactId, no object) is a Contact.
 */
function validateStoredProposal(raw: unknown): { ok: true; proposal: ValidProposal } | { ok: false; detail: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, detail: 'proposal is not an object' };
  }
  const stored = raw as Record<string, unknown>;
  const object = stored.object === undefined && typeof stored.contactId === 'string' ? 'Contact' : stored.object;
  const recordId = stored.recordId ?? stored.contactId;

  if (!isSObjectName(object)) {
    return { ok: false, detail: `unknown object ${JSON.stringify(object)}` };
  }
  if (typeof recordId !== 'string' || !hasIdPrefixFor(object, recordId)) {
    return { ok: false, detail: `record Id ${JSON.stringify(recordId)} is not a valid ${object} Id` };
  }
  if (typeof stored.fields !== 'object' || stored.fields === null) {
    return { ok: false, detail: 'proposal has no fields' };
  }

  const entries = Object.entries(stored.fields as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, detail: 'proposal has no fields' };
  }
  const fields: Record<string, FieldDiff> = {};
  for (const [field, diff] of entries) {
    if (!isWritableField(object, field)) {
      return { ok: false, detail: `field ${field} is not writable on ${object}` };
    }
    const { before, after } = (diff ?? {}) as { before?: unknown; after?: unknown };
    if (!isFieldValue(before) || !OBJECTS[object].writable[field]?.safeParse(after).success) {
      return { ok: false, detail: `field ${field} has a malformed diff` };
    }
    fields[field] = { before, after: after as string | number };
  }

  return { ok: true, proposal: { object, recordId, fields } };
}

const MAX_WRITE_ATTEMPTS = 3;
const BACKOFF_MS: readonly number[] = [250, 500];

function isRetryable(err: unknown): boolean {
  return err instanceof SalesforceApiError && (err.status === undefined || err.status >= 500);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function confirmUpdate(deps: GuardDeps, proposalId: string): Promise<ConfirmUpdateResult> {
  const sleep = deps.sleep ?? defaultSleep;

  const lookup = await deps.proposalStore.consume(proposalId);

  if (lookup.status === 'not_found') {
    await deps.auditLog.append({ event: 'rejected_not_found', timestamp: new Date().toISOString(), proposalId });
    return { status: 'rejected', reason: 'not_found' };
  }

  const validation = validateStoredProposal(lookup.proposal);
  if (!validation.ok) {
    await deps.auditLog.append({
      event: 'rejected_invalid_proposal',
      timestamp: new Date().toISOString(),
      proposalId,
      detail: validation.detail,
    });
    return { status: 'rejected', reason: 'invalid_proposal' };
  }

  const { object, recordId, fields } = validation.proposal;
  const ref = recordRef(object, recordId);

  if (lookup.status === 'expired') {
    await deps.auditLog.append({ event: 'rejected_expired', timestamp: new Date().toISOString(), proposalId, ...ref });
    return { status: 'rejected', reason: 'expired', ...ref };
  }

  const changedFields = Object.keys(fields);
  const currentLive = await deps.sfClient.getRecordFields(object, recordId, changedFields);

  const staleFields: StaleFields = {};
  for (const field of changedFields) {
    const diff = fields[field];
    if (!diff) continue;
    const currentValue = currentLive[field] ?? null;
    if (currentValue !== diff.before) {
      staleFields[field] = { proposedBefore: diff.before, currentValue };
    }
  }

  if (Object.keys(staleFields).length > 0) {
    await deps.auditLog.append({
      event: 'rejected_stale',
      timestamp: new Date().toISOString(),
      proposalId,
      ...ref,
      fields: staleFields,
    });
    return { status: 'rejected', reason: 'stale', ...ref, fields: staleFields };
  }

  const patchFields: Record<string, string | number> = {};
  for (const field of changedFields) {
    const diff = fields[field];
    if (diff) patchFields[field] = diff.after;
  }

  let attempts = 0;
  let lastError: unknown;

  while (attempts < MAX_WRITE_ATTEMPTS) {
    attempts += 1;
    try {
      await deps.sfClient.patchRecord(object, recordId, patchFields);
      const appliedAt = new Date().toISOString();
      await deps.auditLog.append({ event: 'confirmed', timestamp: appliedAt, proposalId, ...ref, fields, appliedAt });
      return { status: 'applied', proposalId, ...ref, fields, appliedAt };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) {
        break;
      }
      const backoff = BACKOFF_MS[attempts - 1];
      if (attempts < MAX_WRITE_ATTEMPTS && backoff !== undefined) {
        await sleep(backoff);
      }
    }
  }

  if (lastError instanceof SalesforceApiError) {
    await deps.auditLog.append({
      event: 'write_failed',
      timestamp: new Date().toISOString(),
      proposalId,
      ...ref,
      fields,
      attempts,
    });
    return { status: 'rejected', reason: 'write_failed', ...ref };
  }

  // Not a SalesforceApiError — a genuine bug rather than a documented Salesforce-call failure
  // mode (sfClient is designed to only ever throw SalesforceApiError). Let it propagate.
  throw lastError;
}
