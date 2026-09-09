import { randomUUID } from 'node:crypto';
import type { AuditLog } from './auditLog.js';
import type { ProposalStore } from './proposalStore.js';
import { SalesforceApiError, type SalesforceClient } from './sfClient.js';
import type { FieldDiff, WritableContactField } from './types.js';

export interface GuardDeps {
  sfClient: SalesforceClient;
  proposalStore: ProposalStore;
  auditLog: AuditLog;
  generateId?: () => string;
  /** Injectable so tests don't burn wall-clock time on the write retry's backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ProposeUpdateInput {
  contactId: string;
  // `| undefined` (rather than plain Partial<Record<...>>) so a zod-parsed object with
  // optional keys — which types each key as `string | undefined`, not "absent or string",
  // under exactOptionalPropertyTypes — is assignable here without the caller stripping keys.
  changes: Partial<Record<WritableContactField, string | undefined>>;
}

export interface ProposeUpdateResult {
  proposalId: string;
  contactId: string;
  fields: Record<string, FieldDiff>;
  expiresAt: string;
}

export async function proposeUpdate(deps: GuardDeps, input: ProposeUpdateInput): Promise<ProposeUpdateResult> {
  const changedFields = Object.keys(input.changes) as WritableContactField[];
  if (changedFields.length === 0) {
    throw new Error('propose_update requires at least one field change');
  }

  const current = await deps.sfClient.getContactFields(input.contactId, changedFields);

  const fields: Partial<Record<WritableContactField, FieldDiff>> = {};
  for (const field of changedFields) {
    const after = input.changes[field];
    if (after === undefined) continue;
    fields[field] = { before: current[field] ?? null, after };
  }

  const generateId = deps.generateId ?? randomUUID;
  const proposal = await deps.proposalStore.create({
    id: generateId(),
    contactId: input.contactId,
    fields,
  });

  await deps.auditLog.append({
    event: 'proposed',
    timestamp: new Date().toISOString(),
    proposalId: proposal.id,
    contactId: proposal.contactId,
    fields: proposal.fields,
  });

  return {
    proposalId: proposal.id,
    contactId: proposal.contactId,
    fields: proposal.fields,
    expiresAt: proposal.expiresAt,
  };
}

export type ConfirmUpdateResult =
  | { status: 'applied'; proposalId: string; contactId: string; fields: Record<string, FieldDiff>; appliedAt: string }
  | { status: 'rejected'; reason: 'not_found' }
  | { status: 'rejected'; reason: 'expired'; contactId: string }
  | {
      status: 'rejected';
      reason: 'stale';
      contactId: string;
      fields: Record<string, { proposedBefore: string | null; currentValue: string | null }>;
    }
  | { status: 'rejected'; reason: 'write_failed'; contactId: string };

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

  const { proposal } = lookup;

  if (lookup.status === 'expired') {
    await deps.auditLog.append({
      event: 'rejected_expired',
      timestamp: new Date().toISOString(),
      proposalId,
      contactId: proposal.contactId,
    });
    return { status: 'rejected', reason: 'expired', contactId: proposal.contactId };
  }

  const changedFields = Object.keys(proposal.fields) as WritableContactField[];
  const currentLive = await deps.sfClient.getContactFields(proposal.contactId, changedFields);

  const staleFields: Record<string, { proposedBefore: string | null; currentValue: string | null }> = {};
  for (const field of changedFields) {
    const diff = proposal.fields[field];
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
      contactId: proposal.contactId,
      fields: staleFields,
    });
    return { status: 'rejected', reason: 'stale', contactId: proposal.contactId, fields: staleFields };
  }

  const patchFields: Partial<Record<WritableContactField, string>> = {};
  for (const field of changedFields) {
    const diff = proposal.fields[field];
    if (diff) patchFields[field] = diff.after;
  }

  let attempts = 0;
  let lastError: unknown;

  while (attempts < MAX_WRITE_ATTEMPTS) {
    attempts += 1;
    try {
      await deps.sfClient.patchContact(proposal.contactId, patchFields);
      const appliedAt = new Date().toISOString();
      await deps.auditLog.append({
        event: 'confirmed',
        timestamp: appliedAt,
        proposalId,
        contactId: proposal.contactId,
        fields: proposal.fields,
        appliedAt,
      });
      return { status: 'applied', proposalId, contactId: proposal.contactId, fields: proposal.fields, appliedAt };
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
      contactId: proposal.contactId,
      fields: proposal.fields,
      attempts,
    });
    return { status: 'rejected', reason: 'write_failed', contactId: proposal.contactId };
  }

  // Not a SalesforceApiError — a genuine bug rather than a documented Salesforce-call failure
  // mode (sfClient is designed to only ever throw SalesforceApiError). Let it propagate.
  throw lastError;
}
