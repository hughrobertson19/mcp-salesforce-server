import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { FieldDiff } from './types.js';

export type AuditEvent =
  | { event: 'proposed'; timestamp: string; proposalId: string; contactId: string; fields: Record<string, FieldDiff> }
  | {
      event: 'confirmed';
      timestamp: string;
      proposalId: string;
      contactId: string;
      fields: Record<string, FieldDiff>;
      appliedAt: string;
    }
  | {
      event: 'rejected_stale';
      timestamp: string;
      proposalId: string;
      contactId: string;
      fields: Record<string, { proposedBefore: string | null; currentValue: string | null }>;
    }
  | { event: 'rejected_not_found'; timestamp: string; proposalId: string }
  | { event: 'rejected_expired'; timestamp: string; proposalId: string; contactId: string }
  | {
      event: 'write_failed';
      timestamp: string;
      proposalId: string;
      contactId: string;
      fields: Record<string, FieldDiff>;
      /** 1 for a non-retryable (4xx) failure, up to 3 for an exhausted retryable one. */
      attempts: number;
    };

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
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
