import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileAuditLog, type AuditEvent } from './auditLog.js';

describe('createFileAuditLog', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'audit-log-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns an empty array before anything has been appended', async () => {
    const log = createFileAuditLog(dataDir);
    expect(await log.readAll()).toEqual([]);
  });

  it('round-trips appended events in order', async () => {
    const log = createFileAuditLog(dataDir);
    const events: AuditEvent[] = [
      { event: 'proposed', timestamp: '2026-01-01T00:00:00.000Z', proposalId: 'p1', object: 'Contact', recordId: '003ABC', contactId: '003ABC', fields: {} },
      { event: 'rejected_not_found', timestamp: '2026-01-01T00:01:00.000Z', proposalId: 'p2' },
      {
        event: 'confirmed',
        timestamp: '2026-01-01T00:02:00.000Z',
        proposalId: 'p1',
        object: 'Contact',
        recordId: '003ABC',
        contactId: '003ABC',
        fields: { Email: { before: 'old@example.com', after: 'new@example.com' } },
        appliedAt: '2026-01-01T00:02:00.000Z',
      },
    ];

    for (const event of events) {
      await log.append(event);
    }

    expect(await log.readAll()).toEqual(events);
  });

  it('writes exactly one JSON object per line', async () => {
    const log = createFileAuditLog(dataDir);
    await log.append({ event: 'rejected_not_found', timestamp: '2026-01-01T00:00:00.000Z', proposalId: 'p1' });
    await log.append({ event: 'rejected_not_found', timestamp: '2026-01-01T00:00:01.000Z', proposalId: 'p2' });

    const raw = await readFile(path.join(dataDir, 'audit-log.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it('writes the object type on each record event, for Account and Opportunity as well as Contact', async () => {
    const log = createFileAuditLog(dataDir);
    await log.append({
      event: 'proposed',
      timestamp: '2026-01-01T00:00:00.000Z',
      proposalId: 'p1',
      object: 'Opportunity',
      recordId: '006ABC',
      fields: { Amount: { before: 50000, after: 75000 } },
    });

    const raw = await readFile(path.join(dataDir, 'audit-log.jsonl'), 'utf8');
    expect(JSON.parse(raw.trim())).toMatchObject({ object: 'Opportunity', recordId: '006ABC' });
  });

  it('still reads log lines written before multi-object support (contactId, no object)', async () => {
    const legacyLine =
      '{"event":"proposed","timestamp":"2026-09-09T20:18:06.227Z","proposalId":"086812c3-c4cc-4101-a7ab-949a873b79f9",' +
      '"contactId":"003000000000001AAA","fields":{"Title":{"before":"SVP, Operations","after":"Test Update"}}}\n';
    await writeFile(path.join(dataDir, 'audit-log.jsonl'), legacyLine, 'utf8');

    const log = createFileAuditLog(dataDir);
    await log.append({ event: 'rejected_not_found', timestamp: '2026-09-09T20:30:00.000Z', proposalId: 'p2' });

    const events = await log.readAll();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'proposed', contactId: '003000000000001AAA' });
  });
});
