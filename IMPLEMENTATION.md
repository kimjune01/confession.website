# confession.website — implementation bootstrap

Brief for an implementer agent to build confession.website from
the settled spec. This document is the starting prompt, not
general documentation — it assumes the reader is about to write
code against DESIGN.md and SPEC.md.

confession.website is a bounded turn-based voice rally with a
text terminator and burn-on-listen semantics. Design and spec
are settled across twelve commits of iteration. **This task is
building it, not re-litigating it.**

## Prerequisites: directory layout

This brief assumes `confession.website` and `ephemeral.website`
are siblings on disk, and that your current working directory
is the root of `confession.website` (or a parallel impl clone
at the same depth, e.g., `confession.website-impl-A`).

```
~/Documents/
  confession.website/           ← this repo (read-only reference)
  confession.website-impl-A/    ← your impl directory (if blind-blind-merge)
  confession.website-impl-B/    ← the other impl directory
  ephemeral.website/            ← sister site; source for copied patterns
```

All `../ephemeral.website/...` references below resolve
correctly from any of the three `confession.website*`
directories because they are siblings of `ephemeral.website/`.

**Before starting, verify:**

```bash
ls ../ephemeral.website/backend/internal/store.go
ls ../ephemeral.website/backend/cmd/upload/main.go
ls ../ephemeral.website/ROADMAP.md
```

If any of those fail, stop and report: the sibling layout is
missing and the copy-from-ephemeral plan won't work. The
operator setting up the impl environment needs to clone
ephemeral.website next to your impl directory before you can
proceed.

## Files to read before writing anything

**Load-bearing, do not modify:**

- `DESIGN.md` — ethos and principles. The "why."
- `SPEC.md` — the implementation target. Types, API shapes,
  atomicity contracts, turn flow, wire limits. The "what."
  Follow it exactly.

**Source of truth to copy from:**

- `../ephemeral.website/backend/internal/store.go` — the
  plumbing module template. Lift the Store struct, NewStore
  constructor, PresignUpload, PresignStream, response helpers.
  Adapt data types to confession's META model.
- `../ephemeral.website/backend/cmd/upload/main.go` (and
  siblings in `cmd/`) — template for a Lambda handler. Copy
  its shape for each of confession's five endpoints.
- `../ephemeral.website/backend/build.sh`, `go.mod`, and
  `infra/` — deploy patterns.
- `../ephemeral.website/ROADMAP.md` — the "don't extract a
  shared library yet, copy with provenance" decision. Honor
  it.

## What to build

1. **Go backend** at `backend/`
   - `go.mod` with module name `confession-backend`, Go 1.25+
   - `backend/internal/` package with:
     - Store struct (DDB + S3 clients + config), copied from
       ephemeral's `store.go` with adapted types
     - Response helpers (`JSON`, `Error`), copied
     - Slug canonicalization (`[a-z0-9-]{3,32}`)
     - Reply code generation (4-char crockford base32)
     - Audio decode + size + MIME validation
     - DDB operations: `PutMeta`, `UpdateMetaBurn`,
       `UpdateMetaCompose` (rally), `GetMeta`, `PutSub`,
       `QuerySubs`, `EvictOldestSub`
     - S3 operations: `UploadAudio`, `GetAudio`, `DeleteAudio`
     - Wordlist for server-generated slugs
     - Docstring at the top of `store.go`: `"pattern from
       ephemeral.website/backend/internal/store.go as of commit
       <sha>"`
   - `backend/cmd/` with five subdirectories, one Lambda per
     endpoint: `compose/`, `probe/`, `listen/`,
     `rally_compose/`, `subscribe/`. Each is a `main.go` that
     calls `lambda.Start` on a handler for
     `events.APIGatewayV2HTTPRequest`.
   - `backend/build.sh` modeled on ephemeral's, building all
     five binaries.
   - Optional: a local dev server at `cmd/local/main.go` that
     runs all handlers on one port for smoke testing.

2. **Frontend** at `frontend/`
   - Check what's already scaffolded (`index.html`,
     `style.css`, `script.js`). Build on that.
   - Surfaces: landing, compose (record/type), listen,
     post-listen inline compose with 5:00→7:00 countdown,
     404, "channel is done" terminal state, push opt-in
     prompt.
   - No framework. Plain HTML + CSS + JS.
   - Reply code lives in URL fragment (`#A4F2`), managed via
     `history.replaceState`. Read on load, write on successful
     listen, clear on successful compose or countdown expiry.
   - Service worker for Web Push. On push receipt: call
     `clients.matchAll({type: 'window'})`, suppress if any tab
     is focused on the origin; otherwise show notification and
     route click to the most-recently-subscribed slug from
     `localStorage.subscriptions`.
   - Audio: MediaRecorder API with Opus codec, 2-min ceiling
     enforced client-side, base64-encoded in the request body.
   - Countdown UI: visible in calm (0-5:00), visibly loud in
     overtime (5:00-7:00), collapse at 7:00.

3. **Infrastructure** at `infra/`
   - Pulumi with Go (matches user preference and ephemeral
     pattern).
   - Resources:
     - DynamoDB table (on-demand billing, TTL on `expires_at`)
     - S3 bucket with lifecycle rule: delete `audio/*` 8 days
       after creation
     - Five Lambda functions, each with its own narrow IAM
       role (listen gets GetItem + UpdateItem + GetObject +
       DeleteObject; rally_compose gets UpdateItem + PutObject;
       etc.)
     - API Gateway v2 HTTP API with routes mapping to the
       five Lambdas
     - CloudFront distribution with the API as an origin,
       static frontend from S3 as another origin
     - Route53 record for `confession.website`
     - WAF with per-IP rate limit (100 req/sec global, 10
       req/sec on POST endpoints)
   - Model on ephemeral's `infra/` layout.

## Constraints that cannot move

- **Follow SPEC.md exactly.** Types, field names, condition
  expressions, endpoint paths, response shapes — all of it.
  Don't paraphrase; replicate.
- **Do not extract a shared library** between confession and
  ephemeral. Copy with provenance docstrings. See
  `../ephemeral.website/ROADMAP.md`.
- **Do not add features** not in the spec. If you think of an
  improvement, flag it in a comment; don't implement it.
- **Do not rename concepts.** "Listen" (not "reveal"). "Reply
  code" (not "token"). "META" (not "slug state"). Match the
  spec's vocabulary.
- **Inline base64 for audio, not presigned URLs.** The spec
  justifies this.
- **One Lambda per endpoint**, not a single router.
- **4-char reply_code** in crockford base32. Not signed, not
  HMAC'd. Plain pointer on META.
- **No cron jobs, no GSIs, no TransactWriteItems.** Every
  mutation is a single-item UpdateItem or PutItem. DDB TTL +
  S3 lifecycle handle cleanup.
- **Concurrent listens return content to both readers**; only
  the burn winner sets `reply_code`.
- **Text-only sends skip the push opt-in prompt** (they
  terminate the channel).

## Methodology: blind-blind-merge

You are working in ONE of TWO separate directories. Another
agent is building the same thing independently in the other.
You do not see their work. They do not see yours. The user
merges the best of each at the end.

Working directories:

- `~/Documents/confession.website-impl-A/`
- `~/Documents/confession.website-impl-B/`

The caller will tell you which one is yours. Your git remote
is a fresh clone of confession.website with DESIGN/SPEC/
IMPLEMENTATION in place.

**Do not** reference the other impl directory. **Do not**
write to `~/Documents/confession.website/` — that's the
read-only reference repo. Commit all your work to your own
impl directory.

Blind-blind-merge only works if the two impls diverge in
interesting ways. Don't over-constrain your choices to match a
hypothetical other impl; just build what the spec says, using
your own judgment for anything the spec leaves open.

## Methodology: volley with codex

After each logical milestone, run codex as a reviewer to catch
implementation bugs and spec drift.

**Milestones (run codex after each):**

1. **Backend scaffolding** — `go.mod`, `internal/` package
   compiles, five handler shells return placeholder 501.
2. **Backend core endpoints** — `compose`, `probe`, `listen`
   work end-to-end against a local DDB + S3 setup or
   `aws-dynamodb-local` + MinIO.
3. **Backend rally endpoints** — `rally_compose`, `subscribe`
   work; the full turn loop (compose → listen → rally_compose
   → listen → compose terminator → listen) passes the smoke
   test below.
4. **Frontend scaffolding** — HTML/CSS/JS structure in place;
   surfaces render; routing between them works without a
   backend.
5. **Frontend flows** — compose/listen/rally work against the
   local backend; countdown, fragment management, push opt-in
   prompt, SW dedup all function.
6. **Infra preview** — `pulumi preview` runs cleanly and
   shows the expected resources without deploying.

**At each milestone, run:**

```bash
codex exec -c model="gpt-5.4" "$(cat <<'PROMPT'
Review this confession.website implementation against the spec
at SPEC.md. Milestone: <N — name>.

Flag, in order of severity:
1. Spec drift — where the code disagrees with SPEC's atomicity
   contracts, endpoint shapes, or field names.
2. Correctness bugs — race conditions, missing error handling,
   wrong DDB condition expressions, unchecked S3 errors.
3. Security issues — content leaked in logs, content in the
   wire response when burn failed, reply_code reuse.
4. Missing features — anything the spec requires that the
   milestone scope should include but doesn't.

Skip style feedback unless it's load-bearing. Report in under
500 words. Don't re-design; the spec is settled.
PROMPT
)"
```

Apply codex's fixes. Re-run codex. Iterate until clean. Then
advance.

## Smoke tests

After backend milestone 3, run this end-to-end turn loop
against a local backend:

```bash
# Art composes first turn (text-only for a simple test)
SLUG=$(curl -s -X POST http://localhost:8080/api/compose \
  -H 'Content-Type: application/json' \
  -d '{"text":"test message","audio_b64":null}' | jq -r .slug)
echo "created: $SLUG"

# Betty probes and listens
curl -s http://localhost:8080/api/slug/$SLUG            # 200 {}
LISTEN=$(curl -s -X POST http://localhost:8080/api/slug/$SLUG/listen)
echo "listened: $LISTEN"
CODE=$(echo $LISTEN | jq -r .reply_code)

# Betty composes rally reply (non-terminal by including audio
# — replace with a real base64 blob)
curl -s -X POST http://localhost:8080/api/slug/$SLUG/compose \
  -H 'Content-Type: application/json' \
  -d "{\"reply_code\":\"$CODE\",\"text\":\"reply text\"}"   # 201 {}

# Art probes — should see new pending
curl -s http://localhost:8080/api/slug/$SLUG            # 200 {}

# Art listens to Betty's reply
curl -s -X POST http://localhost:8080/api/slug/$SLUG/listen

# Second listen on the same slug should 404
curl -s -X POST http://localhost:8080/api/slug/$SLUG/listen   # 404
```

If the whole loop passes, the core state machine is working.

A fuller test should also cover:
- Listen race (two concurrent POSTs → both return 200; only
  one has `reply_code != null`)
- Rally compose with expired reply_code → 404
- Rally compose with advanced tail_seq (second compose with
  same code) → 404
- Text-only terminator: after Art composes text via rally,
  Betty listens → `terminated = true`, `reply_code = null`
- Slug collision on first-turn compose with user-specified
  slug → 409; with auto-generated slug → server retries and
  succeeds

## Style

- Match ephemeral.website's Go conventions: one `main.go` per
  Lambda, `internal/` package for shared code, JSON responses
  via `internal.JSON(code, body)`, errors via
  `internal.Error(code, msg)`, no content in logs.
- Go 1.25+. aws-sdk-go-v2. aws-lambda-go. google/uuid for
  randomness.
- `go fmt ./...` before every commit.
- `go vet ./...` should be clean.
- Commit messages: lowercase, imperative, one-line subject +
  one paragraph body for non-trivial commits. Match the
  existing commit style in confession.website's git log.
- Frontend: no frameworks, no build step if avoidable. Plain
  static files. Match the existing scaffolding in `frontend/`.

## First output expected

Before writing any implementation code, produce this:

1. **Read-through summary.** In under 300 words, summarize
   what you understand about confession.website's state
   machine from reading DESIGN.md and SPEC.md. This is a
   sanity check that you internalized the spec before coding
   against it.

2. **Top three implementation decisions** where the spec is
   precise, but the code pattern copied from ephemeral will
   need non-trivial adaptation. For each: what ephemeral
   does, what confession's spec requires, what the adaptation
   looks like. Example candidates:
   - ephemeral's `BurnToken` returns a Session; confession's
     `UpdateMetaBurn` needs to mint and return a `reply_code`
     in the same atomic write.
   - ephemeral's `Store` has TokensTable + SessionsTable;
     confession's has one table with only META + SUB# items.
   - ephemeral uses PresignStream for audio delivery;
     confession reads + returns bytes inline.

3. **List of open questions**, if any, where the spec is
   actually ambiguous. (Expectation: zero or one.) If you
   find more than two ambiguities, stop and report back
   before proceeding — that's a spec bug, not an
   implementation task.

Volley those three outputs through codex with:

```bash
codex exec -c model="gpt-5.4" "Review this pre-implementation
read-through of confession.website. Flag any misunderstanding
of the spec, any implementation decisions that are wrong, and
any ambiguities the writer missed. Report in under 300 words."
```

Apply codex's corrections. Then start scaffolding the backend.

## Notes on this brief's structure

- **Heavy scope narrowing** so implementation doesn't drift
  into re-designing. SPEC.md is the contract; twelve commits
  of iteration landed it there.
- **Explicit file paths** on everything. The "read these
  files" list is the complete required reading; nothing else
  is needed to start.
- **Blind-blind-merge uses separate directories**, not git
  worktrees — worktrees collapse when two agents write to
  them in parallel.
- **Volley with codex after each milestone** is the Filter
  step: automate the check against the spec, keep the Attend
  for the human reviewer. Don't volley on micro-steps; the
  listed milestones are the right granularity.
- **First-output expectation** forces concrete engagement
  with the spec instead of generic scaffolding. If the
  read-through misses something, it surfaces before coding.
- **"Stop and report" on >2 ambiguities** is the escape
  hatch: if the spec is actually broken, implementation
  shouldn't paper over it.

---

## Operator notes (for the human running impl agents)

These are meta-notes for the person setting up blind-blind-
merge, not instructions for the agent.

**Running blind-blind-merge.** Create two sibling directories
before spawning agents:

```bash
cp -r ~/Documents/confession.website ~/Documents/confession.website-impl-A
cp -r ~/Documents/confession.website ~/Documents/confession.website-impl-B
```

Each impl directory is a full git clone the agent can commit
into. Launch one agent per directory with the single-line
instruction "Your impl directory is
`~/Documents/confession.website-impl-A/`" (or B). The agent
reads this IMPLEMENTATION.md, does its read-through, and starts
scaffolding in its own directory.

**When to merge.** After both agents hit milestone 3 (backend
state machine working end-to-end with the smoke test), diff
the two impl directories and cherry-pick at the file level:
pick the better `backend/internal/store.go` wholesale, the
better `backend/cmd/listen/main.go`, etc. Don't merge at the
function level — that produces Frankenstein code.

**The "first output" tripwire.** If either agent's read-through
summary reveals a misunderstanding, stop. Fix the spec
clarification before coding continues. If both agents miss the
same thing, that's your signal the spec has a real ambiguity —
promote it to a fix before continuing.

**Milestone 3 is the proof point.** Everything before it is
scaffolding; everything after is polish. If an impl fails
milestone 3, merge from the other impl rather than debugging
from scratch.

**Cherry-picking priorities.** When merging, the things
typically worth selecting between impls:
- Clearest handler code
- Most defensive DDB condition expression builder usage
- Best error-path coverage (the failure modes are where impls
  diverge most)
- Cleanest frontend state machine (fewer implicit states)
- Simplest build scripts
