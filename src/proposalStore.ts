import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Proposal } from './types.js';

export type ProposalLookupResult =
  | { status: 'found'; proposal: Proposal }
  | { status: 'not_found' }
  | { status: 'expired'; proposal: Proposal };

export interface ProposalStore {
  create(input: Omit<Proposal, 'createdAt' | 'expiresAt'>): Promise<Proposal>;
  /**
   * Reads and deletes the proposal file in one call. This makes the store single-use by
   * construction — the source of the replay protection between two confirm_update calls
   * against the same proposal id, with no extra bookkeeping required.
   */
  consume(id: string): Promise<ProposalLookupResult>;
}

/**
 * File-backed proposal store: one JSON file per proposal under `{dataDir}/proposals/{id}.json`.
 * File-backed (rather than in-memory) so a proposal survives a server restart between
 * propose_update and confirm_update calls in the same way the audit log does.
 */
export function createFileProposalStore(
  dataDir: string,
  ttlMinutes: number,
  now: () => Date = () => new Date(),
): ProposalStore {
  const proposalsDir = path.join(dataDir, 'proposals');

  function filePathFor(id: string): string {
    return path.join(proposalsDir, `${id}.json`);
  }

  return {
    async create(input) {
      await mkdir(proposalsDir, { recursive: true });
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60_000);
      const proposal: Proposal = {
        ...input,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      await writeFile(filePathFor(proposal.id), JSON.stringify(proposal, null, 2), 'utf8');
      return proposal;
    },

    async consume(id) {
      const file = filePathFor(id);
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          return { status: 'not_found' };
        }
        throw err;
      }
      await rm(file, { force: true });

      const proposal = JSON.parse(raw) as Proposal;
      if (new Date(proposal.expiresAt).getTime() < now().getTime()) {
        return { status: 'expired', proposal };
      }
      return { status: 'found', proposal };
    },
  };
}
