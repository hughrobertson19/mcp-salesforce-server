# mcp-salesforce-server

An [MCP](https://modelcontextprotocol.io) server for Salesforce Contacts, Accounts and Opportunities where irreversible CRM writes get a verify-before-apply step, backed by a server-held "before" snapshot the client can't tamper with.

## Why it's built this way

Letting an AI agent write straight to a live CRM record is the kind of irreversible action that deserves a verification step rather than a single hopeful tool call. Two things go wrong with the naive design:

1. **The agent's information goes stale.** It read a field a few minutes ago; someone else has since changed it in Salesforce. Writing blindly discards that person's edit with no trace.
2. **There's no record of what changed.** A CRM write with no audit trail is hard to review, hard to debug, and hard to trust.

So the write is split in two:

- **`propose_update`** fetches the *current* live values for the fields being changed, computes a before/after diff, appends a dry-run entry to an append-only audit log, and stores the proposal server-side under a generated id. **It never writes to Salesforce.**
- **`confirm_update`** takes only that proposal id — nothing else. The "before" snapshot stays server-side, so a caller cannot supply it, forge it, or quietly adjust it to make the check pass. The server re-fetches the live record, and only if every field still matches what the diff was computed against does the write actually happen. If anything changed in between, the whole confirm is rejected as **stale** and nothing is applied.

That re-verification step is the point of the project, and it works the same way on all three objects. The implementation is [`src/guard.ts`](src/guard.ts); the tests that prove it are [`src/guard.test.ts`](src/guard.test.ts).

## Tools

| Tool | Reads/writes | What it does |
|---|---|---|
| `ping` | — | Smoke-test tool; returns `"pong"`. |
| `list_contacts` | read | List Contacts, optionally filtered by a search term against Name/Email. |
| `get_contact` | read | Fetch one Contact by Id (`contactId`). |
| `list_accounts` | read | List Accounts, optionally filtered by a search term against Name/Website. |
| `get_account` | read | Fetch one Account by Id (`accountId`). |
| `list_opportunities` | read | List Opportunities, optionally filtered by a search term against Name. |
| `get_opportunity` | read | Fetch one Opportunity by Id (`opportunityId`). |
| `propose_update` | read + dry-run log | Diff a proposed change against live values; never writes. Takes `object` (`Contact` by default), `recordId` (or `contactId` for a Contact, as before) and `changes`. |
| `confirm_update` | write (guarded) | Apply a proposal, only if the record hasn't changed since. Takes only the `proposalId`. |

Writable fields are deliberately limited to a per-object allowlist, kept in one config map in [`src/objects.ts`](src/objects.ts):

| Object | Writable fields |
|---|---|
| Contact | `Email`, `Phone`, `Title`, `Department` |
| Account | `Phone`, `Website`, `Industry` |
| Opportunity | `StageName`, `CloseDate` (`YYYY-MM-DD`), `NextStep`, `Amount` (a number) |

Any other field is rejected at propose time with an error naming the fields that are allowed. A record Id must also belong to the object it's proposed against (`003…` Contact, `001…` Account, `006…` Opportunity), so an Account change can't be aimed at a Contact. Existing Contact callers don't need to change anything: `propose_update({ contactId, changes })` behaves exactly as it did.

For the plain-English version of how the guard works (coat check tickets, chain of custody, and a builder re-checking the site), see [`docs/EXPLAINED.md`](docs/EXPLAINED.md).

## Quickstart

```bash
npm install
cp .env.example .env   # then fill in your Salesforce Connected App credentials
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

The Inspector opens a UI for calling the tools against your org; `--cli --method tools/list` does the same non-interactively.

### Salesforce setup

1. Create a **Developer Edition org** at [developer.salesforce.com](https://developer.salesforce.com).
2. In Setup → App Manager, create a **Connected App**: enable OAuth, and under its OAuth policies enable **Client Credentials Flow** with a **Run As** user configured (the flow acts as that user).
3. Copy `.env.example` to `.env` and fill in the Consumer Key/Secret and your org's login URL. `.env` is gitignored and never committed.

## Worked examples

Both transcripts below are from real runs against a live Salesforce Developer Edition org, with the audit-log lines quoted verbatim from `data/audit-log.jsonl`. They were recorded on Contacts before multi-object support, so the log lines have `contactId` and no `object`. Lines written now also carry `object` and `recordId`, and Contact lines still include `contactId`.

### The normal path: propose, then confirm

```jsonc
// propose_update({ contactId: "003bm00001qvbvhAAA", changes: { Title: "Test Update" } })
{
  "proposalId": "086812c3-c4cc-4101-a7ab-949a873b79f9",
  "contactId": "003bm00001qvbvhAAA",
  "fields": { "Title": { "before": "SVP, Operations", "after": "Test Update" } },
  "expiresAt": "2026-09-09T20:33:06.222Z"
}

// confirm_update({ proposalId: "086812c3-c4cc-4101-a7ab-949a873b79f9" })
{
  "status": "applied",
  "proposalId": "086812c3-c4cc-4101-a7ab-949a873b79f9",
  "contactId": "003bm00001qvbvhAAA",
  "fields": { "Title": { "before": "SVP, Operations", "after": "Test Update" } },
  "appliedAt": "2026-09-09T20:20:19.526Z"
}
```

The audit log captures both halves — the dry run and the write that followed it:

```jsonl
{"event":"proposed","timestamp":"2026-09-09T20:18:06.227Z","proposalId":"086812c3-c4cc-4101-a7ab-949a873b79f9","contactId":"003bm00001qvbvhAAA","fields":{"Title":{"before":"SVP, Operations","after":"Test Update"}}}
{"event":"confirmed","timestamp":"2026-09-09T20:20:19.526Z","proposalId":"086812c3-c4cc-4101-a7ab-949a873b79f9","contactId":"003bm00001qvbvhAAA","fields":{"Title":{"before":"SVP, Operations","after":"Test Update"}},"appliedAt":"2026-09-09T20:20:19.526Z"}
```

### The blocked path: the record changed underneath the proposal

Here a change to a different Contact was proposed, and then — to genuinely simulate a concurrent edit rather than stage one in code — the record's `Title` was edited **by hand in the Salesforce UI**, outside this tool entirely, before the confirm was issued.

```jsonc
// propose_update({ contactId: "003bm00001qvbvpAAA", changes: { Title: "Pending Change" } })
{
  "proposalId": "75bd1ff0-b223-48e0-9485-f82172c19307",
  "contactId": "003bm00001qvbvpAAA",
  "fields": { "Title": { "before": "CEO", "after": "Pending Change" } }
}

// ...Title edited directly in the Salesforce UI, from "CEO" to "Interim CEO"...

// confirm_update({ proposalId: "75bd1ff0-b223-48e0-9485-f82172c19307" })
{
  "status": "rejected",
  "reason": "stale",
  "contactId": "003bm00001qvbvpAAA",
  "fields": { "Title": { "proposedBefore": "CEO", "currentValue": "Interim CEO" } }
}
```

```jsonl
{"event":"proposed","timestamp":"2026-09-09T20:39:05.647Z","proposalId":"75bd1ff0-b223-48e0-9485-f82172c19307","contactId":"003bm00001qvbvpAAA","fields":{"Title":{"before":"CEO","after":"Pending Change"}}}
{"event":"rejected_stale","timestamp":"2026-09-09T20:49:19.283Z","proposalId":"75bd1ff0-b223-48e0-9485-f82172c19307","contactId":"003bm00001qvbvpAAA","fields":{"Title":{"proposedBefore":"CEO","currentValue":"Interim CEO"}}}
```

Nothing was written to Salesforce here — on the stale path `patchRecord` is never called, and the hand-made edit ("Interim CEO") survived untouched. Note the two timestamps: the confirm came about ten minutes after the proposal, comfortably inside the 15-minute TTL. This was rejected because the *value* changed, not because the proposal expired — those are separate rejection reasons (`stale` vs `expired`), and this is the first one.

The same call on an Opportunity looks like this. The output shape is the same, with `object` and `recordId` in place of `contactId`:

```jsonc
// propose_update({ object: "Opportunity", recordId: "006...", changes: { Amount: 75000, StageName: "Negotiation/Review" } })
```

A proposal also can't be confirmed twice — it's consumed on first read — and a failed Salesforce write retries transient 5xx/network errors up to three times with backoff while failing fast on a 4xx. [`DECISIONS.md`](DECISIONS.md) covers the reasoning behind each of those.

## Evidence, not assertions

[`src/guard.test.ts`](src/guard.test.ts) is the proof the guard works, rather than a claim that it does. [`src/guard.multiObject.test.ts`](src/guard.multiObject.test.ts) runs the same checks on Contact, Account and Opportunity. For each one it covers the happy path, a stale rejection, a field outside the allowlist, an expired proposal, and a replayed proposal. It also covers wrong-object attempts, including a stored proposal edited on disk to point an Account change at a Contact. Between them they cover a stale write being rejected, a confirm with no prior proposal being rejected, a correct before/after diff reaching the audit log, a clean confirm actually applying, a proposal not being confirmable twice, and the retry/fail-fast behavior on write failures.

Tests that never fail prove nothing, so the guard was checked against deliberate breakage: with the stale-value comparison in `guard.ts` disabled, the suite was rerun and the stale-rejection tests failed exactly as they should have, then the check was restored. This was redone after the multi-object change. With the comparison disabled, 6 of 53 tests failed, and they were exactly the stale-path tests: one for each object, the original Contact test, the multi-field test and the type-mismatch test. That's what establishes the test is exercising the guard rather than just confirming the code runs.

```bash
npm test
```

## Design decisions

Every non-obvious fork in this build — SDK version, transport, auth flow, object choice, proposal storage, audit log format, retry policy, the multi-object generalisation and its allowlist — is recorded in [`DECISIONS.md`](DECISIONS.md) in `Chose / Over / Because` form.

## Project layout

```
src/
  guard.ts             propose/confirm orchestration — the tested core
  objects.ts           per-object config: Id prefix, read fields, write allowlist
  sfClient.ts          Salesforce REST client (auth, query, get, patch)
  proposalStore.ts     file-backed, single-use proposal store
  auditLog.ts          append-only JSON Lines audit log
  tools/               MCP tools (records.ts generates the list_/get_ tools for each object)
  test-utils/          fake Salesforce client used by the guard tests
docs/
  EXPLAINED.md         plain-English walkthrough of the guard
```

## License

MIT — see [`LICENSE`](LICENSE).
