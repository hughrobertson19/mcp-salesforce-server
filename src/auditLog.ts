import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SObjectName } from './objects.js';
import type { FieldDiff, FieldValue } from './types.js';

/**
 * Which record an event is about. Every event that concerns a record carries `object` and
 * `recordId`; Contact events also keep the original `contactId` key (same value) so log lines
 * written before multi-object support, and anything grepping for `contactId`, still read the same.
 * A legacy line with `contactId` and no `object` is a Contact event.
 */
export interface RecordRef {
  object: SObjectName;
  recordId: string;
  contactId?: string;
}

export type StaleFields = Record<string, { proposedBefore: FieldValue; currentValue: FieldValue }>;

export type AuditEvent =
  | ({ event: 'proposed'; timestamp: string; proposalId: string; fields: Record<string, FieldDiff> } & RecordRef)
  | ({
      event: 'confirmed';
      timestamp: string;
      proposalId: string;
      fields: Record<string, FieldDiff>;
      appliedAt: string;
    } & RecordRef)
  | ({ event: 'rejected_stale'; timestamp: string; proposalId: string; fields: StaleFields } & RecordRef)
  | { event: 'rejected_not_found'; timestamp: string; proposalId: string }
  | ({ event: 'rejected_expired'; timestamp: string; proposalId: string } & RecordRef)
  | {
      /** A stored proposal that fails re-validation at confirm time (unknown object, field outside the allowlist, Id from another object). */
      event: 'rejected_invalid_proposal';
      timestamp: string;
      proposalId: string;
      detail: string;
    }
  | ({
      event: 'write_failed';
      timestamp: string;
      proposalId: string;
      fields: Record<string, FieldDiff>;
      /** 1 for a non-retryable (4xx) failure, up to 3 for an exhausted retryable one. */
      attempts: number;
    } & RecordRef);

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
  /** Returns every line as written — including legacy Contact-only lines, which have `contactId` but no `object`/`recordId`. */
  readAll(): Promise<AuditEvent[]>;
}

/** Append-only JSON Lines audit log: one JSON object per line, crash-safe (no read-modify-write). */
export function createFileAuditLog(dataDir: string): AuditLog {
  const filePath = path.join(dataDir, 'audit-log.jsonl');

  return {
    async append(event) {
      await mkdir(dataDir, { recursive: true });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    },

    async readAll() {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          return [];
        }
        throw err;
      }
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AuditEvent);
    },
  };
}
