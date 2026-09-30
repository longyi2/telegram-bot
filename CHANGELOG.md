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
