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
**Because** it's a small standard object with low-risk, relatable fields (Email, Phone, Title, Department) for a public write-demo.

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
