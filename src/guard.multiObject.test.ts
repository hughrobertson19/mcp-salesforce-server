import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileAuditLog } from './auditLog.js';
import { confirmUpdate, proposeUpdate, ProposalValidationError, type GuardDeps } from './guard.js';
import type { SObjectName } from './objects.js';
import { createFileProposalStore } from './proposalStore.js';
import { createFakeSalesforceClient, type FakeRecords } from './test-utils/fakeSalesforceClient.js';
import type { FieldValue } from './types.js';

const CONTACT_ID = '003000000000001AAA';
const ACCOUNT_ID = '001000000000001AAA';
const OPPORTUNITY_ID = '006000000000001AAA';

function fixtures(): FakeRecords {
  return {
    Contact: { [CONTACT_ID]: { Id: CONTACT_ID, Email: 'a@example.com', Phone: '555-0100' } },
    Account: { [ACCOUNT_ID]: { Id: ACCOUNT_ID, Website: 'https://old.example', Phone: '555-0200', Name: 'Acme' } },
    Opportunity: {
      [OPPORTUNITY_ID]: {
        Id: OPPORTUNITY_ID,
        Amount: 50000,
        StageName: 'Prospecting',
        CloseDate: '2026-12-31',
        Probability: 10,
      },
    },
  };
}

function makeDeps(dataDir: string, opts: { now?: () => Date } = {}) {
  const sfClient = createFakeSalesforceClient(fixtures());
  const proposalStore = createFileProposalStore(dataDir, 15, opts.now);
  const auditLog = createFileAuditLog(dataDir);
  const deps: GuardDeps = { sfClient, proposalStore, auditLog, sleep: async () => {} };
  return { deps, sfClient, auditLog };
}

async function proposalFiles(dataDir: string): Promise<string[]> {
  return readdir(path.join(dataDir, 'proposals')).catch(() => []);
}

interface ObjectCase {
  object: SObjectName;
  recordId: string;
  field: string;
  before: FieldValue;
  after: string | number;
  /** The value "someone else" saves in Salesforce between propose and confirm. */
  concurrent: FieldValue;
  /** A real field on the object that is deliberately not on its allowlist. */
  notAllowed: Record<string, string | number>;
}

const CASES: ObjectCase[] = [
  {
    object: 'Contact',
    recordId: CONTACT_ID,
    field: 'Email',
    before: 'a@example.com',
    after: 'b@example.com',
    concurrent: 'c@example.com',
    notAllowed: { LastName: 'Smith' },
  },
  {
    object: 'Account',
    recordId: ACCOUNT_ID,
    field: 'Website',
    before: 'https://old.example',
    after: 'https://new.example',
    concurrent: 'https://other.example',
    notAllowed: { Name: 'Acme Holdings' },
  },
  {
    object: 'Opportunity',
    recordId: OPPORTUNITY_ID,
    field: 'Amount',
    before: 50000,
    after: 75000,
    concurrent: 60000,
    notAllowed: { Probability: 90 },
  },
];

describe.each(CASES)('guard on $object', (c) => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'guard-multi-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('happy path: proposes, confirms and writes to the right object', async () => {
    const { deps, sfClient, auditLog } = makeDeps(dataDir);

    const proposal = await proposeUpdate(deps, { object: c.object, recordId: c.recordId, changes: { [c.field]: c.after } });
    expect(proposal).toMatchObject({ object: c.object, recordId: c.recordId, fields: { [c.field]: { before: c.before, after: c.after } } });

    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result).toMatchObject({ status: 'applied', object: c.object, recordId: c.recordId });
    expect(sfClient.patchCallCount).toBe(1);
    expect(sfClient.patchCalls[c.object]).toBe(1);
    expect(sfClient.getRecord(c.object, c.recordId)?.[c.field]).toBe(c.after);

    const events = await auditLog.readAll();
    expect(events.map((e) => e.event)).toEqual(['proposed', 'confirmed']);
    for (const event of events) {
      expect(event).toMatchObject({ object: c.object, recordId: c.recordId });
    }
  });

  it('rejects as stale when the live value changed after the proposal, and writes nothing', async () => {
    const { deps, sfClient, auditLog } = makeDeps(dataDir);

    const proposal = await proposeUpdate(deps, { object: c.object, recordId: c.recordId, changes: { [c.field]: c.after } });
    sfClient.setField(c.object, c.recordId, c.field, c.concurrent);

    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'stale',
      object: c.object,
      recordId: c.recordId,
      fields: { [c.field]: { proposedBefore: c.before, currentValue: c.concurrent } },
    });
    expect(sfClient.patchCallCount).toBe(0);
    expect(sfClient.getRecord(c.object, c.recordId)?.[c.field]).toBe(c.concurrent);

    const events = await auditLog.readAll();
    expect(events.at(-1)).toMatchObject({ event: 'rejected_stale', object: c.object, recordId: c.recordId });
  });

  it('rejects a field outside the allowlist at propose time, before anything is read or stored', async () => {
    const { deps, sfClient, auditLog } = makeDeps(dataDir);

    const attempt = proposeUpdate(deps, { object: c.object, recordId: c.recordId, changes: c.notAllowed });

    await expect(attempt).rejects.toBeInstanceOf(ProposalValidationError);
    await expect(attempt).rejects.toThrow(`not writable on ${c.object}`);
    expect(sfClient.getCalls[c.object]).toBe(0);
    expect(await proposalFiles(dataDir)).toEqual([]);
    expect(await auditLog.readAll()).toEqual([]);
  });

  it('rejects an expired proposal without reading or writing the record', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const { deps, sfClient, auditLog } = makeDeps(dataDir, { now: () => clock });

    const proposal = await proposeUpdate(deps, { object: c.object, recordId: c.recordId, changes: { [c.field]: c.after } });
    clock = new Date('2026-01-01T00:16:00.000Z'); // past the 15-minute TTL

    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result).toMatchObject({ status: 'rejected', reason: 'expired', object: c.object, recordId: c.recordId });
    expect(sfClient.patchCallCount).toBe(0);

    const events = await auditLog.readAll();
    expect(events.at(-1)).toMatchObject({ event: 'rejected_expired', object: c.object, recordId: c.recordId });
  });

  it('cannot replay a consumed proposal', async () => {
    const { deps, sfClient } = makeDeps(dataDir);

    const proposal = await proposeUpdate(deps, { object: c.object, recordId: c.recordId, changes: { [c.field]: c.after } });

    const first = await confirmUpdate(deps, proposal.proposalId);
    const second = await confirmUpdate(deps, proposal.proposalId);

    expect(first.status).toBe('applied');
    expect(second).toEqual({ status: 'rejected', reason: 'not_found' });
    expect(sfClient.patchCallCount).toBe(1);
  });
});

describe('guard: wrong-object protection', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'guard-wrong-object-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function tamper(proposalId: string, edit: (stored: Record<string, unknown>) => void): Promise<void> {
    const file = path.join(dataDir, 'proposals', `${proposalId}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    edit(stored);
    await writeFile(file, JSON.stringify(stored), 'utf8');
  }

  it('refuses to propose an Account change against a Contact Id', async () => {
    const { deps, sfClient } = makeDeps(dataDir);

    const attempt = proposeUpdate(deps, { object: 'Account', recordId: CONTACT_ID, changes: { Phone: '555-0999' } });

    await expect(attempt).rejects.toThrow('is not a Account Id');
    expect(sfClient.getCalls.Account + sfClient.getCalls.Contact).toBe(0);
    expect(await proposalFiles(dataDir)).toEqual([]);
  });

  it('refuses contactId as the record Id for a non-Contact object', async () => {
    const { deps } = makeDeps(dataDir);

    await expect(
      proposeUpdate(deps, { object: 'Account', contactId: ACCOUNT_ID, changes: { Phone: '555-0999' } }),
    ).rejects.toThrow('contactId is only valid for Contact');
  });

  it('an Account proposal cannot be confirmed against a Contact Id, even if the stored proposal is edited to point at one', async () => {
    const { deps, sfClient, auditLog } = makeDeps(dataDir);

    const proposal = await proposeUpdate(deps, { object: 'Account', recordId: ACCOUNT_ID, changes: { Phone: '555-0999' } });
    await tamper(proposal.proposalId, (stored) => {
      stored.recordId = CONTACT_ID;
    });

    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result).toEqual({ status: 'rejected', reason: 'invalid_proposal' });
    expect(sfClient.patchCallCount).toBe(0);
    expect(sfClient.getRecord('Contact', CONTACT_ID)?.Phone).toBe('555-0100');
    expect(sfClient.getRecord('Account', ACCOUNT_ID)?.Phone).toBe('555-0200');

    const events = await auditLog.readAll();
    expect(events.at(-1)).toMatchObject({ event: 'rejected_invalid_proposal', proposalId: proposal.proposalId });
  });

  it('rejects a stored proposal whose object was switched to one where its fields are not writable', async () => {
    const { deps, sfClient } = makeDeps(dataDir);

    const proposal = await proposeUpdate(deps, { object: 'Account', recordId: ACCOUNT_ID, changes: { Website: 'https://new.example' } });
    await tamper(proposal.proposalId, (stored) => {
      stored.object = 'Contact';
      stored.recordId = CONTACT_ID;
    });

    expect(await confirmUpdate(deps, proposal.proposalId)).toEqual({ status: 'rejected', reason: 'invalid_proposal' });
    expect(sfClient.patchCallCount).toBe(0);
  });

  it('rejects a stored proposal edited to include a field outside the allowlist', async () => {
    const { deps, sfClient } = makeDeps(dataDir);

    const proposal = await proposeUpdate(deps, { object: 'Opportunity', recordId: OPPORTUNITY_ID, changes: { Amount: 75000 } });
    await tamper(proposal.proposalId, (stored) => {
      stored.fields = { ...(stored.fields as object), Probability: { before: 10, after: 100 } };
    });

    expect(await confirmUpdate(deps, proposal.proposalId)).toEqual({ status: 'rejected', reason: 'invalid_proposal' });
    expect(sfClient.patchCallCount).toBe(0);
  });

  it('an Account confirm only ever writes to the Account endpoint', async () => {
    const { deps, sfClient } = makeDeps(dataDir);

    const proposal = await proposeUpdate(deps, { object: 'Account', recordId: ACCOUNT_ID, changes: { Phone: '555-0999' } });
    await confirmUpdate(deps, proposal.proposalId);

    expect(sfClient.patchCalls).toEqual({ Contact: 0, Account: 1, Opportunity: 0 });
    expect(sfClient.getRecord('Contact', CONTACT_ID)?.Phone).toBe('555-0100');
    expect(sfClient.getRecord('Account', ACCOUNT_ID)?.Phone).toBe('555-0999');
  });
});

describe('guard: field typing and edge cases', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'guard-edge-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects inherited object keys like toString as fields, not just unknown names', async () => {
    const { deps } = makeDeps(dataDir);

    await expect(
      proposeUpdate(deps, { object: 'Opportunity', recordId: OPPORTUNITY_ID, changes: { toString: 'x' } }),
    ).rejects.toThrow('not writable on Opportunity');
  });

  it('requires Amount to be a number and CloseDate to be YYYY-MM-DD', async () => {
    const { deps } = makeDeps(dataDir);

    await expect(
      proposeUpdate(deps, { object: 'Opportunity', recordId: OPPORTUNITY_ID, changes: { Amount: '75000' } }),
    ).rejects.toThrow('Invalid value for Opportunity.Amount');
    await expect(
      proposeUpdate(deps, { object: 'Opportunity', recordId: OPPORTUNITY_ID, changes: { CloseDate: '12/31/2026' } }),
    ).rejects.toThrow('Invalid value for Opportunity.CloseDate');
  });

  it('applies a multi-field Opportunity change (StageName + CloseDate) when nothing moved', async () => {
    const { deps, sfClient } = makeDeps(dataDir);

    const proposal = await proposeUpdate(deps, {
      object: 'Opportunity',
      recordId: OPPORTUNITY_ID,
      changes: { StageName: 'Negotiation/Review', CloseDate: '2027-01-31' },
    });
    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result.status).toBe('applied');
    expect(sfClient.getRecord('Opportunity', OPPORTUNITY_ID)).toMatchObject({
      StageName: 'Negotiation/Review',
      CloseDate: '2027-01-31',
    });
  });

  it('rejects the whole write if any one field in the diff moved, and names only that field', async () => {
    const { deps, sfClient } = makeDeps(dataDir);

    const proposal = await proposeUpdate(deps, {
      object: 'Opportunity',
      recordId: OPPORTUNITY_ID,
      changes: { StageName: 'Closed Won', Amount: 75000 },
    });
    sfClient.setField('Opportunity', OPPORTUNITY_ID, 'StageName', 'Closed Lost');

    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'stale',
      fields: { StageName: { proposedBefore: 'Prospecting', currentValue: 'Closed Lost' } },
    });
    expect(result.status === 'rejected' && result.reason === 'stale' && Object.keys(result.fields)).toEqual(['StageName']);
    expect(sfClient.getRecord('Opportunity', OPPORTUNITY_ID)?.Amount).toBe(50000);
  });

  it('fails closed when a live value comes back with a different type than the snapshot', async () => {
    const { deps, sfClient } = makeDeps(dataDir);

    const proposal = await proposeUpdate(deps, { object: 'Opportunity', recordId: OPPORTUNITY_ID, changes: { Amount: 75000 } });
    sfClient.setField('Opportunity', OPPORTUNITY_ID, 'Amount', '50000');

    const result = await confirmUpdate(deps, proposal.proposalId);

    expect(result).toMatchObject({ status: 'rejected', reason: 'stale' });
    expect(sfClient.patchCallCount).toBe(0);
  });

  it('still confirms a pre-multi-object Contact proposal file (contactId, no object)', async () => {
    const { deps, sfClient } = makeDeps(dataDir);
    const legacy = {
      id: 'legacy-1',
      contactId: CONTACT_ID,
      fields: { Email: { before: 'a@example.com', after: 'b@example.com' } },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await mkdir(path.join(dataDir, 'proposals'), { recursive: true });
    await writeFile(path.join(dataDir, 'proposals', 'legacy-1.json'), JSON.stringify(legacy), 'utf8');

    const result = await confirmUpdate(deps, 'legacy-1');

    expect(result).toMatchObject({ status: 'applied', object: 'Contact', recordId: CONTACT_ID, contactId: CONTACT_ID });
    expect(sfClient.patchCalls.Contact).toBe(1);
  });
});
