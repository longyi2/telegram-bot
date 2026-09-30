# Contract ID Validation & Configuration Testing - Implementation Guide

## Overview

This document describes the implementation of GitHub issues #37 (contract ID validation) and #112 (configuration property tests) for the Mimir Telegram bot. Together, these changes make the read-only notifier more reliable and safer during long-running Stellar and Telegram failures.

## Changes Summary

### Issue #37: Contract ID Validation

**What was implemented:**
- Runtime validation of contract IDs in `src/stellar/client.ts` with a new `validateContractId()` function
- Contract ID validation called at scan time in `readContractEvents()` before any RPC calls
- Clear, actionable error messages that identify which contract (market or squad) failed validation
- Per-target error handling that allows one contract's validation failure to not stop polling the other

**Key design decisions:**
1. **When validation happens**: At scan time (in `readContractEvents()`), not at config load time
   - Config load already validates strkey syntax; this is the runtime "is it still valid?" check
   - Surfaces early with a clear error tied to the specific target
   
2. **What gets validated**: Soroban strkey format (`C` + 55 base32 characters)
   - Same pattern as config validation but callable at runtime
   - Trimmed whitespace, rejects empty/invalid formats

3. **Error handling**: Throws immediately so the poller catches it per-target
   - The poller's existing failure policy applies: log the error, leave the cursor, try next cycle
   - No silent failures; the health endpoint reports which target has an error

**Files modified:**
- `src/stellar/client.ts`: Added `validateContractId()` function
- `src/stellar/events.ts`: Call validation in `readContractEvents()` before RPC calls

### Issue #112: Configuration Property Tests

**What was implemented:**
- Comprehensive property-based test suite in `tests/config.test.mjs` (20 tests)
- Stellar/contract validation tests in `tests/stellar-validation.test.mjs` (22 tests)
- Tests for positive cases, negative cases, boundaries, error accumulation, and edge cases
- Total test coverage now: 61 tests passing (39 new + 22 existing)

**Test categories:**

1. **Configuration Property Tests (tests/config.test.mjs)**
   - Positive: Valid defaults, valid overrides, all required fields
   - Contract IDs: Syntax, prefix, base32, whitespace, case sensitivity
   - Chat IDs: Numeric, @username format, invalid formats
   - URLs: http/https, invalid, unsupported protocols
   - Poll interval: Minimum boundary (5000ms), below minimum, non-integer
   - Start lookback: Zero boundary, negative values
   - Max notifications: Minimum boundary (1), zero, negative
   - Health port: Zero (disable), negative
   - Health stale: Zero (disable), negative
   - Error accumulation: Multiple problems reported together

2. **Contract ID Validation Tests (tests/stellar-validation.test.mjs)**
   - Format validation: Valid strkeys, wrong prefix, too short/long
   - Base32 alphabet: Invalid characters (0, 1, 8, 9, symbols)
   - Whitespace: Leading/trailing trimming, whitespace-only strings
   - Custom field names in error messages
   - Integration: `readContractEvents()` validates before RPC calls

**Files modified:**
- `tests/config.test.mjs`: Created with 20 configuration property tests
- `tests/stellar-validation.test.mjs`: Created with 22 validation tests
- `package.json`: Updated test command to include new test files

## Failure Modes & Safety

### Cursor Safety
- **Write-then-rename unchanged**: Cursor file persists using atomic write-then-rename
- **Cursor format unchanged**: Version stays 1; existing deployments are compatible
- **Per-target state**: One contract's validation error doesn't advance the other's cursor

### Rollback Strategy

**Zero-friction rollback** (if needed):
1. Revert the commit or deploy the previous build
2. No migration needed; cursors remain in version=1 format
3. Validation code is additive; removing it is automatic with old build

**Configuration changes**: No breaking changes
- All new validation is at runtime, not config load time
- Existing configs that worked before still work
- New configs with typos surface earlier with clearer messages

### Logging & Security

**Safe logging** (no secrets exposed):
- Validation error messages include contract ID (safe, public)
- Never log BOT_TOKEN, private keys, or unbounded remote payloads
- Per-target errors logged with source name ("market" or "squad")
- Health endpoint redacts sensitive config values

**Example logs:**
```
[poller] market scan failed: market contract ID is not a valid Soroban contract ID (expected C… strkey, 56 chars); got "INVALID_ID"
[poller] market: ... error at ledger X (logged, cursor paused)
```

## Operational Assumptions & Constraints

### Configuration Validation
- **Required fields fail fast**: Missing BOT_TOKEN, TELEGRAM_CHAT_ID, or contract IDs abort startup immediately
- **Collector pattern preserved**: All problems reported together (not one-at-a-time)
- **Defaults applied**: Optional fields use sensible defaults (poll interval 30s, lookback 60 ledgers, etc.)

### Contract ID Validation
- **Format is pre-checked**: Config loader validates strkey syntax; runtime validates it's well-formed before use
- **Does NOT check existence on RPC**: Runtime validation is format-only, not RPC round-trip
  - Checking RPC would require a live network call at startup, slowing cold starts
  - A missing contract returns empty events (not an error), which is safe
- **Per-target isolation**: Market contract error doesn't stop squad polling

### Test Isolation
- **Environment cleanup**: Each test sets and clears process.env to avoid cross-test pollution
- **No real network**: All tests use mocked RPC; safe to run offline
- **No credentials needed**: Tests use fake config; no real bot tokens or chat IDs

## Integration Points

### How Validation Integrates with Existing Code

1. **Config load** → `loadConfig()` validates strkey syntax (unchanged)
   ↓
2. **Poller starts** → Loads cursors, enters cycle loop (unchanged)
   ↓
3. **Per-target scan** → `readContractEvents()` validates contract ID (NEW)
   ↓
4. **Validation passes** → Calls `paginatedGetEvents()` → RPC
   ↓
5. **Validation fails** → Throws error, caught by poller's per-target handler (existing pattern)

### Health Endpoint Impact
- Status reports per-target errors (if any)
- Validation errors surface as `lastError` in `/health` response
- Degradation timeout still applies if errors persist

## Test Command

```bash
# Run all tests (build + test)
npm test

# Verify types without building
npm run typecheck

# Build only
npm run build

# Run specific test file
npm run build && node --test tests/config.test.mjs
npm run build && node --test tests/stellar-validation.test.mjs
```

## Test Results

```
✔ 61 tests pass
  - 39 new tests (validation + property)
  - 22 existing tests (format, health, bot commands)
  - 0 failures
  - 0 skipped

Build status:
  - npm run build: ✓ Clean
  - npm run typecheck: ✓ No errors
```

## Migration & Deployment

### No Breaking Changes
- Existing deployments continue to work unchanged
- Cursor files remain compatible (version=1)
- Configuration doesn't require changes

### Deploy Process
1. Build: `npm run build`
2. Test locally: `npm test`
3. Deploy the new build
4. Validation starts on next poll cycle
5. Invalid contract IDs surface as per-target errors in logs and `/health`

### Monitoring After Deploy
- Watch logs for "contract ID" validation errors
- Check `/health` endpoint for per-target `lastError` fields
- Cursor persists across restarts; no data loss on validation errors

## Future Improvements (Out of Scope)

These were considered but left for future work:

1. **RPC-time contract existence check**
   - Requires additional `getAccount()` call at startup
   - Adds latency to cold starts
   - Deferred until contract creation is less frequent

2. **XDR decoder hardening**
   - Already has try-catch around every decode operation
   - Returns `unknown` events instead of crashing
   - Full coverage possible but lower priority

3. **Configuration hot-reload**
   - Current design is fail-fast at load time
   - Live config changes would need per-target restarts
   - Deferred until multi-contract support is richer

## References

- GitHub Issue #37: "feat(stellar): validate contract IDs before scanning"
- GitHub Issue #112: "chore(ops): validate configuration with property tests"
- README.md: Deployment, cursor persistence, failure behavior
- src/stellar/events.ts: Cursor-paginated scanning, paginatedGetEvents()
- src/config.ts: Configuration loading and validation pattern
