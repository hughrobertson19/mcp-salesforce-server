import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileProposalStore } from './proposalStore.js';

describe('createFileProposalStore', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'proposal-store-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns the stored proposal on the first consume', async () => {
    const store = createFileProposalStore(dataDir, 15);
    const created = await store.create({
      id: 'p1',
      object: 'Contact',
      recordId: '003ABC',
      fields: { Email: { before: 'old@example.com', after: 'new@example.com' } },
    });

    const result = await store.consume('p1');

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.proposal).toEqual(created);
    }
  });

  it('returns not_found for an id that was never created', async () => {
    const store = createFileProposalStore(dataDir, 15);
    const result = await store.consume('never-created');
    expect(result).toEqual({ status: 'not_found' });
  });

  it('returns not_found on a second consume of the same id (single-use)', async () => {
    const store = createFileProposalStore(dataDir, 15);
    await store.create({ id: 'p1', object: 'Contact', recordId: '003ABC', fields: {} });

    const first = await store.consume('p1');
    const second = await store.consume('p1');

    expect(first.status).toBe('found');
    expect(second).toEqual({ status: 'not_found' });
  });

  it('returns expired once the injected clock passes expiresAt', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const store = createFileProposalStore(dataDir, 15, () => clock);

    await store.create({ id: 'p1', object: 'Contact', recordId: '003ABC', fields: {} });

    clock = new Date('2026-01-01T00:16:00.000Z'); // 16 minutes later, past the 15-minute TTL
    const result = await store.consume('p1');

    expect(result.status).toBe('expired');
  });

  it('records the object type on every stored proposal', async () => {
    const store = createFileProposalStore(dataDir, 15);
    await store.create({ id: 'p1', object: 'Opportunity', recordId: '006ABC', fields: { Amount: { before: 50000, after: 75000 } } });

    const result = await store.consume('p1');

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.proposal).toMatchObject({ object: 'Opportunity', recordId: '006ABC' });
    }
  });

  it('treats a path-like id as not_found without touching files outside the store', async () => {
    const store = createFileProposalStore(dataDir, 15);
    await writeFile(path.join(dataDir, 'outside.json'), '{}', 'utf8');

    const result = await store.consume('../outside');

    expect(result).toEqual({ status: 'not_found' });
    await expect(readFile(path.join(dataDir, 'outside.json'), 'utf8')).resolves.toBe('{}');
  });
});
