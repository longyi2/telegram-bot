# Feature #90: Control Link Previews Per Notification Type

## Summary
This PR implements per-contract control of link preview rendering in Telegram notifications, allowing operators to configure whether link previews are shown for market or squad contract notifications independently.

## Changes

### Configuration
- **New Environment Variables:**
  - `LINK_PREVIEW_MARKET` (default: `false`) - Enable/disable link previews for market contract notifications
  - `LINK_PREVIEW_SQUAD` (default: `false`) - Enable/disable link previews for squad contract notifications
  - Accepted values: `true/false`, `1/0`, `yes/no`, `on/off` (case-insensitive)
  - These settings apply only to event notifications; bot commands (`/status`, `/help`, etc.) always have link previews disabled

### Code Changes
1. **src/config.ts**
   - Added `linkPreviewMarket` and `linkPreviewSquad` boolean fields to `BotConfig` interface
   - Added default values (both `false` for backward compatibility) to `DEFAULTS`
   - Added config loading for both new environment variables
   - Added entries to `CONFIG_KEYS` for provenance tracking

2. **src/bot.ts**
   - Modified `createNotifier()` to compute `link_preview_options` dynamically based on contract source
   - Market notifications use `config.linkPreviewMarket` setting
   - Squad notifications use `config.linkPreviewSquad` setting
   - Commands (where source is undefined) always have link previews disabled
   - Plain-text fallback respects the same link preview settings as MarkdownV2

3. **src/notifications/format.ts**
   - Updated `previewMessage()` to accept link preview configuration
   - Now displays current link preview status ("enabled" or "disabled") in preview messages
   - Shows preview for the appropriate contract when `/preview market` or `/preview squad` is called

4. **.env.example**
   - Added documentation for the new `LINK_PREVIEW_MARKET` and `LINK_PREVIEW_SQUAD` options

5. **tests/link-preview-control.test.mjs**
   - Added comprehensive test suite with 18 test cases covering:
     - Positive cases: link previews disabled/enabled for both contracts
     - Market and squad notifications with independent settings
     - Commands always have link previews disabled regardless of config
     - Chat routing respects link preview settings
     - Plain text fallback behavior
     - Backward compatibility (all defaults disabled)
     - Preview message display of current settings

## Failure Modes & Deployment Notes

### Cursor Safety
- **No cursor changes:** This feature only affects the Telegram send options and never touches event processing, cursor advancement, or dedup logic. Cursors remain fully compatible and unaffected.
- **Rollback safe:** A deployment using this feature can safely roll back to a previous version without cursor migration. The new settings are optional and default to the previous "always disabled" behavior.

### Telegram API Behavior
- **Link preview disabling:** When `is_disabled: false`, Telegram's client will unfold URLs found in the message. This is a client-side feature and doesn't affect the message itself.
- **Malformed messages:** If an URL in a message causes Telegram to reject the message formatting, the plain-text fallback (when provided) still respects the link preview setting and will be sent.

### Operational Impact
- **Default behavior unchanged:** All link previews are disabled by default, maintaining the current safe, reliable behavior for existing deployments.
- **Per-contract granularity:** Market and squad contracts can have independent link preview settings, allowing operators to enable previews for one while keeping them disabled for the other.
- **Command consistency:** All bot commands always have link previews disabled, regardless of the notification settings. This ensures operator commands remain stable and predictable.

### RPC & Telegram Failures
- **RPC failures:** No change. Link preview settings are purely local configuration and never depend on RPC state.
- **Telegram failures:** If Telegram rejects a message, the retry with plain-text fallback uses the same link preview setting. The feature doesn't introduce new failure modes.
- **Configuration errors:** Invalid boolean values in `LINK_PREVIEW_*` variables are caught at startup by the same configuration validation that applies to all other settings (e.g., `NOTIFY_*`).

### Health & Status
- **GET /health:** The config provenance report includes the new settings (as names only, never values), showing which settings came from the environment, `.env` file, or defaults.
- **GET /status:** No changes to the status output. Link preview settings are not exposed in status messages.
- **Audit trail:** Link preview settings are not logged in the audit trail; they're part of the static configuration captured at startup.

## Backward Compatibility
- ✅ **100% backward compatible:** Default values maintain the current "previews disabled" behavior
- ✅ **No cursor format changes:** Version-1 cursor format unchanged
- ✅ **No protocol changes:** Telegram API payloads use the same standard structure
- ✅ **No feature flag interactions:** Link preview settings are independent of existing `NOTIFY_*` feature flags

## Testing
All tests pass locally:
- 18 new tests in `tests/link-preview-control.test.mjs`
- Tests cover positive cases, boundary cases, regressions, routing, and plain-text fallback
- Tests verify independent market/squad settings
- Tests confirm backward compatibility (all defaults disabled)
- Tests validate preview command behavior

## Related Issues
Closes #90
