# Build report: phase 1, multi-object guard

Branch `feat/multi-object-guard`, opened as a draft PR against `main`. `main` itself was not touched. No live Salesforce calls were made, `.env` was never read, and no dependencies were added.

`npm run lint`, `npm run build` and `npm test` all pass.

## What changed

**Guard (`src/guard.ts`)**
- Every proposal now records `object` and `recordId`.
- `propose_update` resolves the object (default `Contact`). It rejects:
  - any field outside that object's allowlist
  - any value of the wrong type (Amount must be a number, CloseDate must be `YYYY-MM-DD`)
  - any record Id whose key prefix doesn't match the object (`003` Contact, `001` Account, `006` Opportunity)

  Only then does it fetch the live values and store the proposal.
- `confirm_update` still takes only the proposal id. After consuming the proposal, it re-validates what's stored (known object, allowlisted fields, Id prefix, well-formed diff) before fetching or writing anything. A failure here is the new rejection `invalid_proposal`, logged as `rejected_invalid_proposal`.
- Unchanged: the server-held before-snapshot, the live re-fetch, the strict `!==` stale comparison on the raw API value, the 15-minute TTL, consume-on-read, and the retry/backoff behaviour.

**Allowlist (`src/objects.ts`)**: one config map.

| Object | Writable fields |
|---|---|
| Contact | Email, Phone, Title, Department |
| Account | Phone, Website, Industry |
| Opportunity | StageName, CloseDate, NextStep, Amount |

**Tools**
- `list_contacts` and `get_contact` have the same names, inputs and output as before.
- New read tools: `list_accounts`, `get_account`, `list_opportunities` and `get_opportunity`. All six read tools are generated from the config map in `src/tools/records.ts`.
- `propose_update` gains `object` (default `"Contact"`) and `recordId`. `contactId` still works for Contacts, so `propose_update({ contactId, changes })` behaves as it did.
- `confirm_update` is unchanged: it takes `proposalId` only.

**Salesforce client**: `getContactFields` and `patchContact` became `getRecordFields(object, …)` and `patchRecord(object, …)`. The object name only ever comes from the config map.

**Audit log**: every record event now carries `object` and `recordId`. Contact events also keep `contactId`, so old and new Contact lines read the same. A line with no `object` is a Contact line from before this change. Old proposal files still confirm and are read as Contact.

**Extra hardening (not in the brief, flagged for your review)**: the proposal store now only accepts proposal ids made of `[A-Za-z0-9-]`. Previously the client-supplied id was used directly as a file name, and `consume()` deletes the file it reads, so an id like `../x` could reach and delete a `.json` file outside `data/proposals/`. Any other id is now treated as `not_found`. This is its own commit (`Reject path-like proposal ids…`), so it's easy to drop if you'd rather not have it in this PR.

**Docs**:
- README tool table, allowlist table and evidence section
- seven new DECISIONS.md entries
- `docs/EXPLAINED.md`: coat check ticket, chain of custody, builder re-checking the site

## Test counts

| File | Before | After |
|---|---|---|
| auditLog.test.ts | 3 | 5 |
| proposalStore.test.ts | 4 | 6 |
| sfClient.test.ts | 6 | 7 |
| guard.test.ts | 8 | 8 |
| guard.multiObject.test.ts | — | 27 |
| **Total** | **21** | **53** |

The 8 original guard tests still call `proposeUpdate` with `{ contactId, changes }`, so they double as the Contact back-compat check. The only edits to them were:
- passing the fake client's records under `Contact`
- the one `setField` call
- adding `object`/`recordId` to two exact-equality assertions

`guard.multiObject.test.ts` covers:
- **Per object** (Contact, Account, Opportunity): happy path, stale rejection, field outside the allowlist, expired proposal, replay of a consumed proposal. That's 15 tests.
- **Wrong-object checks**:
  - an Account change against a Contact Id is refused at propose
  - `contactId` used with a non-Contact object is refused
  - an Account proposal edited on disk to point at a Contact Id is rejected
  - an Account proposal switched to object Contact is rejected
  - a stored proposal with an injected Probability field is rejected
  - an Account confirm writes only to Account
- **Typing and edge cases**:
  - inherited keys like `toString` are rejected
  - Amount must be a number and CloseDate must be `YYYY-MM-DD`
  - a multi-field StageName + CloseDate change applies
  - a multi-field diff is rejected when any one field moved
  - a type mismatch in the live value fails closed as stale
  - a legacy Contact proposal file still confirms

## Mutation check

In `src/guard.ts` I changed `if (currentValue !== diff.before)` to `if (false && currentValue !== diff.before)`, which disables the stale comparison, and ran `npm test`.

**Result: 6 failed, 47 passed (53).** The 6 failures were exactly the stale-path tests:
- `guard on Contact › rejects as stale…`
- `guard on Account › rejects as stale…`
- `guard on Opportunity › rejects as stale…`
- `guard.test.ts › rejects confirm_update when the live value has changed… (stale)`
- `rejects the whole write if any one field in the diff moved…`
- `fails closed when a live value comes back with a different type…`

No other test failed. I then reverted with `git checkout src/guard.ts`, confirmed `git diff --exit-code src/guard.ts` was clean, and reran: 53/53 pass. The mutation was never committed.

## Smoke test

I ran the built server over stdio with dummy credentials, from a scratch directory so `.env` wasn't loaded, and sent no Salesforce traffic:
- `tools/list` returned all 9 tools.
- `propose_update` with Opportunity `Probability` was rejected with the allowed field list.
- An Account change aimed at a `003…` Id was rejected.
- `get_account` with a Contact Id was rejected.
- `confirm_update` with `../../etc/passwd` returned `not_found`.

## Left open (none of these weaken the guard; noting them for your judgement)

1. **Fields outside the diff aren't guarded, by design (same as Contacts before).** Changing StageName makes Salesforce update Probability, ForecastCategoryName and IsClosed/IsWon. Those aren't in the diff, so a concurrent edit to them won't trip the stale check. Likewise, a proposal for `Amount` alone won't notice someone changing `StageName`. If you want "Amount and StageName move together", that's a phase 2 design choice: either always snapshot a dependent-field set, or require both in the same proposal.
2. **Picklist validity is left to Salesforce.** An unknown StageName or Industry value gets a 400 from Salesforce, which shows up as `write_failed` with one attempt. Validating it on our side would need a describe call per org.
3. **Multi-currency orgs.** Amount is written in the record's currency. `CurrencyIsoCode` isn't snapshotted.
4. **The Opportunity README example is the call shape only.** The output and audit lines still need a live run (below).
5. **Proposal id charset**: see "Extra hardening" above. A behaviour change for anyone confirming non-UUID ids, which nothing in this repo does.

No `OPEN_QUESTIONS.md` was needed: nothing in the brief required weakening the guard.

## Morning live test: stale rejection on an Opportunity Amount

1. **Permissions.** In Setup, check that the Connected App's *Run As* user can read and edit Opportunity, including field-level edit access to Amount. Account access is needed too if you want to try the Account tools.
2. **Build and start.** From the repo, on this branch:
   ```bash
   git checkout feat/multi-object-guard
   npm install
   npm run build
   npx @modelcontextprotocol/inspector node dist/index.js
   ```
3. **Pick a record.** Call `list_opportunities` (optionally `{ "search": "..." }`). Copy an Opportunity Id (starts with `006`), then call `get_opportunity { "opportunityId": "<id>" }` and note the current `Amount`, say 50000.
4. **Propose.** Call:
   ```json
   propose_update { "object": "Opportunity", "recordId": "<id>", "changes": { "Amount": 75000 } }
   ```
   Check the response shows `"Amount": { "before": 50000, "after": 75000 }`, and copy the `proposalId`. The 15-minute clock starts now.
5. **Edit by hand.** In the Salesforce UI, open that Opportunity, change Amount to something else (say 60000) and save.
6. **Confirm.** Call `confirm_update { "proposalId": "<proposalId>" }`. Expect:
   ```json
   { "status": "rejected", "reason": "stale", "object": "Opportunity", "recordId": "<id>",
     "fields": { "Amount": { "proposedBefore": 50000, "currentValue": 60000 } } }
   ```
7. **Check nothing was written.** Refresh the Opportunity in Salesforce. Amount should still be your hand-entered 60000, not 75000.
8. **Check the log.** Run `tail -2 data/audit-log.jsonl`. You should see a `proposed` line and a `rejected_stale` line, both with `"object":"Opportunity"`.
9. **Optional:** paste the transcript and the two log lines into the README's worked examples, replacing the call-shape-only Opportunity snippet.

If step 6 says `expired`, more than 15 minutes passed: re-propose and go again. If it says `applied`, stop. That would mean the hand edit didn't save before the confirm, or something is wrong. The audit log line will show which.
