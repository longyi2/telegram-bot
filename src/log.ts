/**
 * Safe log helpers.
 *
 * Anything written to stdout/stderr may be captured by a log aggregator, crash
 * reporter, or a developer pasting it into a chat. A bot token or Stellar
 * private seed in that output is a secret leak — even though this bot holds no
 * signing keys, the token is a credential and must never appear in logs.
 *
 * `sanitise()` strips two classes of secret:
 *
 *  1. Telegram bot token pattern  (numeric-id:alphanumeric-secret).
 *  2. Stellar private seed strkeys (`S` + 55 base32 characters).  The bot
 *     does not use seeds, but one could still appear in a config error message
 *     if someone pastes the wrong value into .env.
 *
 * Every console call in the poller, bot and entry point routes through these
 * wrappers so the rule is structural rather than call-site discipline.
 */

// Telegram bot token:  \d+:[A-Za-z0-9_-]{35,}
// The second segment is 35 characters today, but we match ≥20 to be robust.
const BOT_TOKEN_RE = /\d{5,}:[A-Za-z0-9_\-]{20,}/g;

// Stellar private seed: S + 55 uppercase base32 characters (A-Z 2-7).
const STELLAR_SEED_RE = /S[A-Z2-7]{55}/g;

/**
 * Replace any bot tokens or Stellar private seeds in `text` with a
 * `[REDACTED]` placeholder.  The rest of the string is unchanged.
 */
export function sanitise(text: string): string {
  return text.replace(BOT_TOKEN_RE, "[REDACTED:token]").replace(STELLAR_SEED_RE, "[REDACTED:seed]");
}

/**
 * Serialise an arbitrary log argument to a string, applying sanitisation.
 *
 * - Strings are sanitised directly.
 * - Errors include the sanitised message and stack.
 * - Everything else is JSON-serialised (bigint → string) then sanitised.
 */
function serialise(arg: unknown): string {
  if (typeof arg === "string") return sanitise(arg);
  if (arg instanceof Error) {
    const stack = arg.stack ? sanitise(arg.stack) : "";
    const msg = sanitise(arg.message);
    return stack || msg;
  }
  try {
    return sanitise(JSON.stringify(arg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch {
    return sanitise(String(arg));
  }
}

function format(args: unknown[]): string {
  return args.map(serialise).join(" ");
}

/** Sanitising drop-in replacements for the four console methods we use. */
export const log = {
  info: (...args: unknown[]) => console.log(format(args)),
  warn: (...args: unknown[]) => console.warn(format(args)),
  error: (...args: unknown[]) => console.error(format(args)),
  debug: (...args: unknown[]) => {
    if (process.env["LOG_DEBUG"] === "1") console.debug(format(args));
  },
};
