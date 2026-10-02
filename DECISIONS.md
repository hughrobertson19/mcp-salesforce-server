# Decisions

Design forks made while building this repo, in `Chose / Over / Because` format.

---

**Chose** `@modelcontextprotocol/sdk` v1
**Over** the newer split v2 (`@modelcontextprotocol/server` + `@modelcontextprotocol/client`)
**Because** v1 is the actively-maintained, battle-tested package (1.30.0, last published Jul 2026), while v2 self-describes as "calibration" status. A project whose whole point is "verified working end-to-end" shouldn't carry avoidable SDK risk. Verified on the npm registry that v1.30.0 accepts `"zod": "^3.25 || ^4.0"` as a peer dependency, so there's no version conflict pulling in current zod.

---

**Chose** stdio transport
**Over** SSE/HTTP
**Because** this is local-process, single-client usage (MCP inspector, Claude Desktop, Claude Code) — HTTP transport would add auth/session concerns unrelated to what this project demonstrates.

---

**Chose** OAuth 2.0 Client Credentials flow
**Over** username-password flow
**Because** it's a machine-to-machine, no-user-session credential model appropriate for a server acting as itself, not impersonating a user, and it avoids storing a password plus security token.

---

**Chose** Salesforce Contact
**Over** Account or another object
**Because** it's a small standard object with low-risk, relatable fields (Email, Phone, Title, Department) for a public write-demo. *(Phase 0 choice. Phase 1 extended the same guard to Account and Opportunity; see below.)*

---

**Chose** a server-side, file-backed proposal store
**Over** a stateless client-echoed payload
**Because** the "before" snapshot has to be tamper-proof. If the client supplied the before-value on `confirm_update`, a compromised or buggy client could forge a pass on the stale-check — the whole guard would be decorative. This is the load-bearing security property of the project.

---

**Chose** native `fetch`
**Over** `jsforce` or `axios`
**Because** Node 26 ships `fetch` built in, and it leaves one fewer abstraction layer between a reviewer and the actual HTTP calls being made to Salesforce.

---

**Chose** a JSON Lines audit log
**Over** a single JSON array or a database
**Because** it's append-only and crash-safe (no read-modify-write of a whole file), trivially `grep`-able, and needs zero extra dependency for a project this size.

---

**Chose** consume-on-read for the proposal store (`consume()` reads and deletes in one call)
**Over** a separate "mark as used" step
**Because** it gives replay protection for free in a single-process server, at the cost of not handling true concurrent/multi-process confirms — explicitly out of scope at this size.

---

**Chose** reactive token refresh (cache indefinitely, discard and retry once on a 401)
**Over** proactive TTL-based expiry
**Because** Salesforce's client-credentials token endpoint doesn't reliably return a usable `expires_in`, so a TTL-based cache isn't really implementable against this flow.

---

**Chose** built-in `process.loadEnvFile()` and `crypto.randomUUID()`
**Over** the `dotenv` and `uuid` packages
**Because** Node 26 provides both natively, consistent with the project's minimal-dependency stance.

---

**Chose** retry-with-backoff (up to 3 attempts, 250ms then 500ms) around the write itself, failing into a distinct `write_failed` result
**Over** either throwing immediately or silently swallowing a write error
**Because** a transient Salesforce API blip shouldn't force a full re-propose when the stale-check has already passed — but a genuinely down API shouldn't hang the tool call or masquerade as success either. The already-consumed proposal is not restored on failure; that's safe because the write sets absolute field values, not deltas, so re-proposing from scratch is idempotent.

---

**Chose** status-code-based retry classification (retry on no-response/`5xx`, fail fast on any `4xx`)
**Over** retrying every write failure uniformly
**Because** a `4xx` (bad input, permission, not-found) will fail identically on every retry — retrying it only delays a certain outcome. Only failures that plausibly resolve on their own (server-side, or no response at all) are worth the wait. The audit log's `write_failed` event carries an `attempts` count (1 for fail-fast, up to 3 for exhausted retries) rather than needing a second event type for the distinction.

---

**Chose** one generalised guard where every proposal records its object type (`object` + `recordId`), with `confirm_update` still taking only the proposal id
**Over** a copy of the propose/confirm pair per object (`propose_account_update`, `confirm_opportunity_update`, ...), or having the client pass the object again at confirm time
**Because** the security property lives in one place: the server-held before-snapshot, the live re-fetch, the strict stale comparison, the TTL and consume-on-read. Three copies would be three chances for one of them to drift. Having the client restate the object at confirm would hand it back a piece of the proposal, which is exactly what the opaque id exists to prevent. The object is part of the server-held snapshot like everything else.

---

**Chose** a single per-object allowlist config map (`src/objects.ts`): object → Id prefix, read fields, writable fields, and a validator per writable field
**Over** per-tool zod schemas, or a field blocklist
**Because** propose, confirm, the read tools and the tool descriptions all read the same map, so there is one place to audit "what can this server write?". An allowlist fails closed: a field nobody thought about, including one an admin adds to the org later, is unwritable by default. The check uses own-property lookup, so inherited keys like `constructor` can never pass as allowlisted. The allowlist is enforced inside the guard, not just in the MCP tool's input schema, so it holds for any caller. `confirm_update` re-checks a stored proposal against the map before fetching or writing (known object, allowlisted fields, Id prefix). That way a corrupted or hand-edited proposal file can't become a back door.

---

**Chose** to include `Amount` and `StageName` on Opportunity
**Over** limiting Opportunity to low-stakes text fields like `NextStep`
**Because** they're the riskiest fields on the object: they drive pipeline, forecast and commission, and a rep or a manager may be editing them at the same moment. That's exactly why they need the guard. A guard that only covers fields where a lost update doesn't matter proves nothing. These are the fields where silently overwriting a concurrent edit would cost real money, and where an audit trail of before/after values matters most. Keeping them out would have made the demo safer and the project less honest.

---

**Chose** a strict comparison (`!==`) of the raw JSON value Salesforce returns, for numbers and dates as well as text
**Over** normalising values before comparing (e.g. `String(amount)`, parsing dates)
**Because** normalisation is a way for two different values to compare equal, which is the one failure the stale check can't afford. Amount arrives as a JSON number and CloseDate as a `YYYY-MM-DD` string. The before-snapshot stores them exactly as received, and the comparison is against the same API's output. A type change (say, a number coming back as a string) is reported as stale. That costs at most a needless re-propose and never a bad write. Proposed values are validated by type too: `Amount` must be a number and `CloseDate` must be `YYYY-MM-DD`.

---

**Chose** to check the record Id's standard key prefix (`003` Contact, `001` Account, `006` Opportunity) at propose time and again at confirm time
**Over** trusting that the record Id and object match
**Because** it makes "an Account proposal confirmed against a Contact" impossible by construction rather than relying on Salesforce returning a 404. It costs nothing, needs no API call, and catches both a caller's mistake at propose time and a tampered proposal file at confirm time. A failed check at confirm is its own result, `invalid_proposal`, logged as `rejected_invalid_proposal`, and nothing is fetched or written.

---

**Chose** to add `object` and `recordId` to every audit event while keeping `contactId` on Contact events
**Over** renaming `contactId` to `recordId` outright
**Because** the audit log is append-only. Existing lines can't be rewritten, and the README quotes some of them. Keeping `contactId` on Contact events means old and new Contact lines read the same and `grep contactId` still finds them all. A line without `object` is, by definition, a Contact line from before this change. The same applies to proposal files: one written before the upgrade (no `object`) is read as a Contact proposal and goes through the same re-validation.

---

**Chose** to restrict proposal ids to `[A-Za-z0-9-]` in the proposal store
**Over** using the client-supplied id as a file name as-is
**Because** `confirm_update`'s only input becomes a path under `data/proposals/`, and the store deletes what it reads. An id like `../something` could otherwise reach a file outside the store. Anything outside the charset is reported as `not_found` without touching the filesystem. Generated ids (`randomUUID`) are unaffected.
