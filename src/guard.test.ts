import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileAuditLog } from './auditLog.js';
import { createFileProposalStore } from './proposalStore.js';
import { confirmUpdate, proposeUpdate, type GuardDeps } from './guard.js';
import { createFakeSalesforceClient } from './test-utils/fakeSalesforceClient.js';
import type { Contact } from './types.js';

const CONTACT_ID = '003ABC';
const noSleep: (ms: number) => Promise<void> = async () => {};

function makeDeps(dataDir: string, initial: Record<string, Contact>, opts: { sleep?: (ms: number) => Promise<void> } = {}) {
  const sfClient = createFakeSalesforceClient(initial);
  const proposalStore = createFileProposalStore(dataDir, 15);
  const auditLog = createFileAuditLog(dataDir);
  const deps: GuardDeps = {
    sfClient,
    proposalStore,
    auditLog,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  };
  return { deps, sfClient, auditLog };
}

describe('guard: proposeUpdate / confirmUpdate', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'guard-test-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects confirm_update when the live value has changed since propose_update (stale)', async () => {
    const { deps, sfClient, auditLog } = makeDeps(dataDir, {
      [CONTACT_ID]: { Id: CONTACT_ID, Email: 'a@example.com' },
    });

    const proposal = await proposeUpdate(deps, { contactId: CONTACT_ID, changes: { Email: 'b@example.com' } });

    // Simulate someone editing the record in Salesforce directly after the proposal was made.
    sfClient.setField(CONTACT_ID, 'Email', 'c@example.com');

    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'stale',
      contactId: CONTACT_ID,
      fields: { Email: { proposedBefore: 'a@example.com', currentValue: 'c@example.com' } },
    });
    expect(sfClient.patchCallCount).toBe(0);

    const events = await auditLog.readAll();
    expect(events.at(-1)).toMatchObject({
      event: 'rejected_stale',
      proposalId: proposal.proposalId,
      contactId: CONTACT_ID,
      fields: { Email: { proposedBefore: 'a@example.com', currentValue: 'c@example.com' } },
    });
  });

  it('rejects confirm_update when there was no prior proposal', async () => {
    const { deps, auditLog } = makeDeps(dataDir, { [CONTACT_ID]: { Id: CONTACT_ID, Email: 'a@example.com' } });

    const result = await confirmUpdate(deps, randomUUID());

    expect(result).toEqual({ status: 'rejected', reason: 'not_found' });

    const events = await auditLog.readAll();
    expect(events.at(-1)?.event).toBe('rejected_not_found');
  });

  it('writes a correct before/after diff to the audit log on propose_update', async () => {
    const { deps, auditLog } = makeDeps(dataDir, {
      [CONTACT_ID]: { Id: CONTACT_ID, Email: 'a@example.com', Title: 'Engineer' },
    });

    const proposal = await proposeUpdate(deps, {
      contactId: CONTACT_ID,
      changes: { Email: 'b@example.com', Title: 'Senior Engineer' },
    });

    expect(proposal.fields).toEqual({
      Email: { before: 'a@example.com', after: 'b@example.com' },
      Title: { before: 'Engineer', after: 'Senior Engineer' },
    });

    const events = await auditLog.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'proposed',
      proposalId: proposal.proposalId,
      contactId: CONTACT_ID,
      fields: proposal.fields,
    });
  });

  it('applies the write and logs a confirmed entry when nothing has changed', async () => {
    const { deps, sfClient, auditLog } = makeDeps(dataDir, {
      [CONTACT_ID]: { Id: CONTACT_ID, Email: 'a@example.com' },
    });

    const proposal = await proposeUpdate(deps, { contactId: CONTACT_ID, changes: { Email: 'b@example.com' } });
    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result.status).toBe('applied');
    expect(sfClient.patchCallCount).toBe(1);

    const events = await auditLog.readAll();
    expect(events.at(-1)).toMatchObject({
      event: 'confirmed',
      proposalId: proposal.proposalId,
      contactId: CONTACT_ID,
      fields: { Email: { before: 'a@example.com', after: 'b@example.com' } },
    });
  });

  it('cannot confirm the same proposal twice (replay protection)', async () => {
    const { deps, sfClient } = makeDeps(dataDir, { [CONTACT_ID]: { Id: CONTACT_ID, Email: 'a@example.com' } });

    const proposal = await proposeUpdate(deps, { contactId: CONTACT_ID, changes: { Email: 'b@example.com' } });

    const first = await confirmUpdate(deps, proposal.proposalId);
    const second = await confirmUpdate(deps, proposal.proposalId);

    expect(first.status).toBe('applied');
    expect(second).toEqual({ status: 'rejected', reason: 'not_found' });
    expect(sfClient.patchCallCount).toBe(1);
  });

  it('retries a retryable (5xx) write failure and applies once the transient failure clears', async () => {
    const { deps, sfClient, auditLog } = makeDeps(
      dataDir,
      { [CONTACT_ID]: { Id: CONTACT_ID, Email: 'a@example.com' } },
      { sleep: noSleep },
    );
    sfClient.failNextPatchCalls([503, 503]); // fails twice, succeeds on the 3rd attempt

    const proposal = await proposeUpdate(deps, { contactId: CONTACT_ID, changes: { Email: 'b@example.com' } });
    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result.status).toBe('applied');
    expect(sfClient.patchCallCount).toBe(3);

    const events = await auditLog.readAll();
    expect(events.at(-1)?.event).toBe('confirmed');
  });

  it('exhausts retries on a persistently retryable (5xx/network) write failure', async () => {
    const { deps, sfClient, auditLog } = makeDeps(
      dataDir,
      { [CONTACT_ID]: { Id: CONTACT_ID, Email: 'a@example.com' } },
      { sleep: noSleep },
    );
    sfClient.failNextPatchCalls([503, undefined, 503]); // undefined = simulated network failure

    const proposal = await proposeUpdate(deps, { contactId: CONTACT_ID, changes: { Email: 'b@example.com' } });
    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result).toEqual({ status: 'rejected', reason: 'write_failed', contactId: CONTACT_ID });
    expect(sfClient.patchCallCount).toBe(3);

    const events = await auditLog.readAll();
    expect(events.at(-1)).toMatchObject({
      event: 'write_failed',
      proposalId: proposal.proposalId,
      attempts: 3,
    });

    // The proposal was already consumed — a write failure does not restore or reuse it.
    const followUp = await confirmUpdate(deps, proposal.proposalId);
    expect(followUp).toEqual({ status: 'rejected', reason: 'not_found' });
  });

  it('fails fast with exactly one attempt on a non-retryable (4xx) write failure', async () => {
    const { deps, sfClient, auditLog } = makeDeps(
      dataDir,
      { [CONTACT_ID]: { Id: CONTACT_ID, Email: 'a@example.com' } },
      { sleep: noSleep },
    );
    sfClient.failNextPatchCalls([404]);

    const proposal = await proposeUpdate(deps, { contactId: CONTACT_ID, changes: { Email: 'b@example.com' } });
    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result).toEqual({ status: 'rejected', reason: 'write_failed', contactId: CONTACT_ID });
    expect(sfClient.patchCallCount).toBe(1);

    const events = await auditLog.readAll();
    expect(events.at(-1)).toMatchObject({
      event: 'write_failed',
      proposalId: proposal.proposalId,
      attempts: 1,
    });
  });
});
