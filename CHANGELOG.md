# Changelog

All notable changes to **mimir-stellar/telegram-bot** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions correspond to the `version` field in `package.json`.

---

## [0.2.0] — 2026-09-30

### Summary

Hardened the notifier for long-running deployments on Stellar Testnet and
Mainnet. The main themes are: bounded failure behaviour on both the RPC and
Telegram sides, safe log output that never leaks credentials, stale-cursor
detection on startup, and a wider test suite that covers every known event
type plus all new code paths.

### Added

#### RPC retry with exponential back-off (`src/poller.ts`)

Transient Soroban RPC failures are retried up to **3 times** (configurable
internally) with exponential back-off starting at 2 s, doubling each attempt
(2 s → 4 s → 8 s).  Only after all retries are exhausted is the failure
counted against the consecutive-failure counter.  This prevents transient
network blips from triggering a false-positive alert.

The retry logic lives in the exported `withRetry<T>` helper, which is tested
directly.

#### Telegram rate-limit handling (`src/poller.ts`)

When Telegram responds with HTTP **429 Too Many Requests**, the poller reads
the `retry_after` seconds from the error (via the exported `extractRetryAfter`
helper), sleeps exactly that duration, and retries the send once.  Any error
that is not a 429 is re-thrown immediately so the failure counter is accurate.
The helper is tested for all known grammy and HTTP error shapes.

#### Consecutive-failure alerting (`src/poller.ts`, `.env.example`)

After **N consecutive poll cycles** in which every scan target fails (after
retries), the poller posts a single plain-text warning to the configured
Telegram chat.  The alert fires once per failure run and resets when any cycle
partially succeeds.

`N` defaults to **5** and can be tuned per-deployment:

```
CONSECUTIVE_FAILURE_ALERT_THRESHOLD=5
```

A lower value suits a production channel where any gap is notable; a higher
value suits Testnet where short RPC outages are routine.

#### Safe log sanitisation (`src/log.ts`)

A new `src/log.ts` module provides `sanitise()` and a `log` object (`log.info`,
`log.warn`, `log.error`, `log.debug`).

`sanitise()` redacts two classes of secret before any string touches a log
line:

| Pattern | Replacement |
|---|---|
| Telegram bot token (`\d+:[A-Za-z0-9_-]{20,}`) | `[REDACTED:token]` |
| Stellar private seed (`S[A-Z2-7]{55}`) | `[REDACTED:seed]` |

All `console.*` calls in `src/poller.ts`, `src/bot.ts`, and `src/index.ts`
have been replaced with the sanitising wrappers.  The rule is now structural:
adding a new log call automatically benefits from redaction, with no per-call
discipline needed.

The bot holds no signing keys, so seed redaction is a defence-in-depth measure
against a misconfigured `.env` that accidentally contains a seed.

#### Stale-cursor detection on startup (`src/poller.ts`)

When loading `data/cursor.json` at startup, the poller decodes the ledger
number from each saved cursor (via `eventCursorLedger`) and compares it to the
RPC's current `oldestLedger`.  If the cursor's ledger is below the retained
floor:

- A warning is logged: `cursor ledger N is below the retained floor M; discarding stale cursor, cold-starting`.
- The cursor is discarded for that target; the `lastEventLedger` bookmark is preserved.
- The target cold-starts `START_LOOKBACK_LEDGERS` behind the tip instead of
  receiving an RPC error on the first poll.

A cursor inside the retained window is accepted unchanged.  If the health
check itself fails at startup, stale detection is skipped and all cursors
are loaded as-is (conservative fallback).

#### Wider test coverage (`tests/format.test.mjs`)

The test suite grew from 8 to **51 tests** with no live network calls or
credentials required.  New categories:

| Category | Examples |
|---|---|
| **Positive — all known events** | All 9 market events, all 6 squad events produce non-null messages |
| **Negative — unknown/admin events** | `unknown`, admin events (`oracle_changed`, `fee_policy_set`, …) return `null` |
| **Boundary** | Empty summary, 300-char question clipped, zero amount, very large amount, negative amount |
| **Safe logging** | `sanitise` redacts tokens, seeds, multiple secrets; leaves plain text unchanged |
| **`extractRetryAfter`** | All grammy/HTTP error shapes, non-429 returns `null` |
| **`withRetry`** | First-success, second-attempt success, exhaustion, zero-retry |
| **Cursor stale detection** | Round-trip from cursor string → ledger → floor comparison |
| **Restart regression** | `formatEvent` returns `null` for `unknown` events from both sources |

#### CI test step (`.github/workflows/ci.yml`)

The CI pipeline now runs `npm test` (which runs `npm run build` then
`node --test`) after the existing Typecheck and Build steps.  No Testnet RPC
or Telegram token is required.

---

### Changed

- **`src/bot.ts`** — `console.error` / `console.warn` replaced with
  `log.error` / `log.warn` from `src/log.ts`.
- **`src/index.ts`** — all `console.*` calls replaced with `log.*` equivalents.
  The bot token is deliberately absent from boot-time log lines.
- **`src/poller.ts`** — `loadCursors` now accepts an `oldestLedger` argument
  (from a pre-fetched health check) and performs stale detection per target.
  `console.*` calls replaced with `log.*`.

---

### Failure modes and operational notes

#### RPC failure

A single RPC call failure fails one target for one cycle.  Its cursor is
untouched.  With the new retry logic, a call that fails three times in a row
counts as one failure.  After `CONSECUTIVE_FAILURE_ALERT_THRESHOLD` consecutive
all-fail cycles an alert is posted.

Recovery is automatic: as soon as any target scan succeeds the counter resets
and a new alert will fire on the next run of failures.

#### Telegram failure

A failed send (after the 429 retry) drops one message and increments
`notificationsFailed` in `/status`.  **The cursor advances.**  Deliberate:
holding the cursor on a send failure would replay events indefinitely into a
chat the bot was removed from.  Notifications are lossy by design; the chain
is the record.

#### Stale cursor

A cursor that has aged past the RPC's retained window (~120,960 ledgers /
~1 week on Testnet) is automatically discarded on startup.  The affected target
cold-starts `START_LOOKBACK_LEDGERS` behind the current tip.  Events between
the stale cursor and the cold-start ledger are not replayed.  This is the same
trade-off as an ephemeral restart; see the deployment note below.

#### Corrupt cursor file

Unchanged from v0.1: a cursor file that cannot be parsed is treated as a cold
start.  A file that cannot be written is logged; the in-memory cursor keeps
working until the next restart.

---

### Cursor compatibility

`data/cursor.json` format is unchanged (schema `version: 1`).  A v0.1 cursor
file is valid in v0.2.  If its cursors are stale the new startup check will
discard them gracefully rather than crashing.

---

### Deployment impact

| Aspect | Notes |
|---|---|
| **Environment variables** | `CONSECUTIVE_FAILURE_ALERT_THRESHOLD` is new and optional; the default (5) matches prior implicit behaviour. No existing variable has changed. |
| **`data/cursor.json`** | Backward-compatible; no migration needed. |
| **Log output** | The format of log lines is largely unchanged, but any line that previously contained a bot token or seed will now contain `[REDACTED:token]` or `[REDACTED:seed]`. Log parsers that match on the raw token will need updating. |
| **Telegram chat** | The bot now has permission to send a plain-text alert (no MarkdownV2) when the RPC is persistently down. No new Telegram permission is required; `sendMessage` to the existing `TELEGRAM_CHAT_ID` is already assumed. |
| **Persistent volume** | Recommendation unchanged: mount `data/` on a persistent volume. An ephemeral filesystem means every restart is a cold start and events during the downtime are not replayed. |

---

## [0.1.0] — initial release

First working version: grammy bot, cursor-paginated Soroban event reader,
MarkdownV2 formatter for all mimir-market and mimir-squad events, write-then-
rename cursor persistence, `/status` command, and a standalone `npm run scan`
CLI for verifying the decoder against Testnet without a bot token.
All notable changes to this project are documented here.

## [Unreleased]

### Added

**Malformed-event robustness**

- `clip()` is now applied to the `category` field in `claim_created` notifications (bounded
  to 80 characters). `question` in `market_created` and `summary` in `claim_resolved` were
  already clipped at 200 characters. This prevents a crafted or unexpectedly long contract
  string from producing an oversized Telegram message or an unbounded log line.
- `clip()` is now exported from `src/notifications/format.ts` so it can be used from tests
  and shared utilities without re-implementing the cap logic.
- The event name and decode-error reason logged when skipping an `unknown` event are now
  bounded (80 and 120 characters respectively) to prevent unbounded remote payloads reaching
  log output.

**Stale cursor detection**

- The poller now warns when a persisted cursor points to a ledger that is more than 12 096
  ledgers (~10 % of the Testnet retention window) behind the RPC's current `oldestLedger`.
  Events in the gap will never be delivered; the warning names the cursor file path and
  explains how to recover (`delete the cursor file to cold-start`).
- The threshold constant `STALE_CURSOR_LEDGER_LAG` is documented inline.

**Configurable inter-send delay**

- New env var `INTER_SEND_DELAY_MS` (default `1500`) controls the pause between successive
  Telegram sends in one poll cycle. The previous hardcoded `1500 ms` constant is now a
  validated config field (`interSendDelayMs` on `BotConfig`), documented in `.env.example`,
  and accessible to tests without any fixed delay (`interSendDelayMs: 0`).

**Rate-cap logging**

- When `MAX_NOTIFICATIONS_PER_CYCLE` is reached the poller now emits a single
  `console.warn` for the entire cycle (not one per dropped event) that names the cap,
  explains what to do, and confirms that the cursor still advances.

**Consecutive-failure circuit-breaker logging**

- When the poller completes a cycle where every contract scan failed, it increments
  `consecutiveFailures` (this existed before). It now also emits a structured `console.warn`
  the first time the count crosses each threshold (5, 10, 25, 50, 100). The warning names
  the RPC URL, the last error (bounded to 200 characters), and confirms the cursor is intact.

**Cursor file version guard**

- `loadCursors()` now explicitly checks `parsed.version`. If the field is absent or is not
  `1`, the poller cold-starts and logs an actionable warning rather than silently proceeding
  with an unknown file layout. This protects against reading a cursor file written by a
  future release after a downgrade.

**Scanner CLI improvements**

- `--contract <market|squad>` flag added: scans only the named contract instead of both.
  Passing an unrecognised value exits immediately with a clear error message.
- `--help` / `-h` flag added: prints the full usage block and exits without making any
  network calls.
- `--pages` and `--show` flags now validate their arguments (must be integers within a
  stated range) and exit with an error rather than silently using `NaN`.
- `--show` is capped at 200 decoded events per contract (`SCAN_SHOW_MAX`).

**Log safety**

- The bot token, private keys, and payment proofs are never logged. No log path in the
  poller, bot, or config loader references `config.botToken`.
- Remote string payloads (`eventName`, decode reasons, error messages) that reach log lines
  are passed through `clip()` with explicit bounds before logging.
- `errMessage()` in `poller.ts` always returns a plain string, so stack traces from the RPC
  or grammy are bounded by JavaScript's own `Error.message` field rather than re-serialised
  response bodies.

### Changed

- `clip()` in `src/notifications/format.ts` is now `export`ed (was a module-private
  function). No callers outside the module existed before; making it exported enables direct
  testing without duplication.
- The standalone `events.ts` CLI `flag()` helper is joined by `flagBool()` and `flagInt()`
  to support the new validated flags.
- `SEND_SPACING_MS` in `poller.ts` (previously a module-level constant) is replaced by
  `config.interSendDelayMs` so the value is configurable without a code change.

### Tests

- **`tests/format.test.mjs`** — extended with 7 new cases:
  - `clip()` at exactly the boundary, over the boundary, empty string, and whitespace-only
    input.
  - Category bounded in `claim_created` notification.
  - Question bounded in `market_created` notification.
  - Summary bounded in `claim_resolved` notification.
- **`tests/config.test.mjs`** — new file, 22 cases:
  - `BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MARKET_CONTRACT_ID` required-field validation.
  - Multi-problem collection in one `ConfigError`.
  - `INTER_SEND_DELAY_MS`: default, `0`, custom value, non-integer, negative.
  - `MAX_NOTIFICATIONS_PER_CYCLE`: default, minimum (1), below minimum (0).
  - `POLL_INTERVAL_MS`: below 5000 rejected, exactly 5000 accepted.
  - Chat ID: numeric negative, `@channelusername`, invalid format.
  - `networkLabel`: testnet, public, custom.
  - `loadStellarConfig` works without Telegram credentials.
  - `ConfigError` message content and `problems` array.
- **`tests/poller.test.mjs`** — new file, 10 cases:
  - Version guard: no version field → cold-start + warning; version 99 → cold-start + warning;
    version 1 → no version warning.
  - Rate-cap warning text contains the cap value.
  - `interSendDelayMs` config field is present and typed correctly.
  - Circuit breaker: `consecutiveFailures` increments after all scans fail.
  - Stale cursor: warning emitted when lag exceeds threshold; no warning when within range.
  - Log safety: bot token does not appear in any log output during poller construction.

### CI

- `.github/workflows/ci.yml` now runs `npm test` (which includes `tsc` + all three test
  files) rather than running `npm run typecheck` and `npm run build` separately. The
  previous two-step job is replaced by a single `Build and test` step.

---

## Failure modes, cursor safety, and deployment impact

### Failure modes

| Failure | What happens | Recovery |
|---|---|---|
| RPC call fails | That contract's scan is skipped for one cycle; cursor is left untouched | Auto-resumes next cycle |
| RPC retention gap (stale cursor) | Warning logged; events in the gap are not posted | Delete cursor file; bot cold-starts from the current tip |
| Telegram send fails | One message is dropped; cursor still advances | None — notifications are lossy by design |
| Cursor file missing | Cold-start `START_LOOKBACK_LEDGERS` behind the tip | Normal operation |
| Cursor file unreadable or corrupt | Cold-start; warning logged | Normal operation |
| Cursor file has unknown version | Cold-start; warning logged with recovery instructions | Normal operation |
| All contracts fail for N consecutive cycles | Structured warning at thresholds 5, 10, 25, 50, 100 | Check RPC and Telegram connectivity |
| `MAX_NOTIFICATIONS_PER_CYCLE` reached | Remaining events in the cycle skipped; one warning logged; cursor advances | Raise the cap or wait for the backlog to drain |

### Cursor safety

The cursor file is written with a write-then-rename pattern (`.tmp` → final), so a crash
mid-write cannot produce a truncated file that replays the entire retained history.

The file includes a `version: 1` field. Future schema changes will use a different version
number; the poller will cold-start rather than silently misread an unknown layout.

On an ephemeral filesystem (e.g. a container without a persistent volume), every restart is a
cold start. Mount `data/` (or the path in `CURSOR_FILE`) on a persistent volume to preserve
the resume position across restarts.

### Deployment impact of this change

- **New env var `INTER_SEND_DELAY_MS`** — optional, default `1500`. Existing deployments are
  unaffected; the default matches the previous hardcoded constant.
- **No change to the cursor file format** — existing `data/cursor.json` files with
  `"version": 1` load without modification.
- **CI now runs the test suite** — `npm test` replaces the previous typecheck-only CI job.
  The build output is still produced as part of `npm test`.
