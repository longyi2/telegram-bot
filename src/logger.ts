/**
 * Bounded in-memory log capture for operators, plus the `/export` message.
 *
 * ── Why capture at all ───────────────────────────────────────────────────────
 *
 * When this notifier misbehaves the operator usually has exactly two vantage
 * points: `/status` (which reports state, not history) and the process log on
 * the host (which an operator of a hosted deployment may not be able to see).
 * A bounded ring of the bot's own recent console lines, requestable from the
 * chat itself, closes that gap without adding a log shipper or a file sink.
 *
 * ── Safety properties (the whole point) ──────────────────────────────────────
 *
 *  - Capture is REDACT-FIRST: `attachConsole()` wraps console so a line is
 *    redacted BEFORE it is stored. A secret that reaches the buffer at all is
 *    a bug (and `renderLogExport` redacts again as a final net).
 *  - The buffer is a fixed-size ring (`LOG_BUFFER_LINES`, default 500, `0`
 *    disables). Nothing unbounded is ever retained — not remote payloads, not
 *    full explorer URLs, not per-line timestamps beyond relative ages.
 *  - Redaction never invents output: it masks substrings, so a line either
 *    contains the placeholder or the original text, never a mix beyond that.
 *  - The export is plain text with NO MarkdownV2 parse mode, so arbitrary
 *    log content can never break message formatting or inject entities.
 *  - The export includes a summary + counters + redacted logs and is
 *    hard-capped again at send time (`MAX_EXPORT_CHARS`).
 *
 * What is deliberately NOT here: writing log files, shipping logs anywhere,
 * or holding anything richer than the lines the bot already printed.
 */

import { networkLabel, type BotConfig } from "./config.js";
import type { PollerStatus } from "./poller.js";

/** Placeholder substituted for every redacted span. */
export const REDACTED = "●●●";

/** Hard cap on the rendered export, independent of the ring size. */
export const MAX_EXPORT_CHARS = 32_000;

/** One captured console line, normalized to a level and a redacted string. */
export interface LogLine {
  /** Monotonic capture sequence, for ordering after ring wraparound. */
  seq: number;
  /** `Date.now()` at capture, so ages can be shown without storing ISO text. */
  at: number;
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export interface LogCapture {
  /** Redact and append one line. Drops the oldest when the ring is full. */
  add(level: LogLine["level"], text: string): void;
  /** Recent lines, oldest first. */
  lines(): LogLine[];
  /** Number of lines currently held (≤ configured capacity). */
  size(): number;
  /** Configured capacity (0 = capture disabled). */
  capacity(): number;
}

/**
 * Redact secrets from one log line before it can be stored or shown.
 *
 * Order matters: the literal bot token is masked first (it is the most
 * dangerous and the most likely to appear verbatim in a rejected-URL error),
 * then the chat id, then any full-precision account/contract strkey (those
 * are public on-chain data, but a full id in a pasted log is more identifying
 * than it needs to be).
 */
export function redactLine(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  // Full-precision Stellar strkeys (G…/C…, 56 chars) -> first 4 + … + last 4.
  // Shortened display forms like `CDV6…LPKZI` are left alone; the ellipsis
  // means there is nothing more to hide.
  out = out.replace(/\b[GC][A-Z2-7]{55}\b/g, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`);
  return out;
}

/** Derive the literal substrings that must never survive into the buffer. */
export function secretsFor(config: BotConfig): string[] {
  return [config.botToken, config.chatId].filter((s) => s.length > 0);
}

/**
 * Create the ring buffer. Capacity 0 means capture is disabled: `add` is a
 * no-op and `lines()` is always empty, so callers need no special casing.
 */
export function createLogCapture(capacity: number): LogCapture {
  const cap = Math.max(0, Math.floor(capacity));
  const ring: LogLine[] = [];
  let nextSeq = 0;

  return {
    add(level, text) {
      if (cap === 0) return;
      const line: LogLine = { seq: nextSeq++, at: Date.now(), level, text };
      if (ring.length >= cap) ring.shift();
      ring.push(line);
    },
    lines() {
      return [...ring];
    },
    size() {
      return ring.length;
    },
    capacity() {
      return cap;
    },
  };
}

/**
 * Wrap console.log/info/warn/error so every line the bot prints is captured
 * (already redacted). Returns a restore function so tests can unwire.
 *
 * Note: this only sees `console.*` output, which is the only logging this bot
 * does. Library chatter (e.g. grammy internals) that bypasses console is not
 * captured — acceptable for a notifier whose own lines carry the story.
 */
export function attachConsole(capture: LogCapture, secrets: string[]): () => void {
  const methods = ["log", "info", "warn", "error"] as const;
  type LogFn = (...args: unknown[]) => void;
  const originals = new Map<string, LogFn>();

  for (const level of methods) {
    const original = console[level] as LogFn;
    originals.set(level, original);
    console[level] = (...args: unknown[]) => {
      // Original first: the host's own output stays untouched even if the
      // capture below throws (it must never take down the real log call).
      original(...args);
      try {
        capture.add(level, redactLine(args.map(String).join(" "), secrets));
      } catch {
        // Capture is best-effort by contract.
      }
    };
  }

  return () => {
    for (const level of methods) {
      const original = originals.get(level);
      if (original) console[level] = original;
    }
  };
}

function agoShort(timestamp: number, now: number): string {
  const s = Math.max(0, Math.round((now - timestamp) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/**
 * Render the operator export: a state summary plus the redacted recent logs.
 *
 * Plain text on purpose — it is sent without a parse mode, so nothing in the
 * log content can affect formatting, and no credential or payment amount
 * beyond what `/status` already shows is included.
 */
export function renderLogExport(
  config: BotConfig,
  status: PollerStatus,
  capture: LogCapture,
  now: number = Date.now(),
): string {
  const lines: string[] = [];
  lines.push("Mimir notifier log export");
  // Network label is display-safe (testnet/public/custom) — not the RPC URL,
  // which could name a private endpoint.
  lines.push(`network: ${networkLabel(config)} · log lines kept: ${capture.capacity()}`);
  lines.push(
    `running: ${status.running ? "yes" : "no"} · cycles: ${status.cycles} · ` +
      `sent: ${status.notificationsSent} · failed sends: ${status.notificationsFailed} · ` +
      `skipped: ${status.eventsSkipped} · consecutive failures: ${status.consecutiveFailures}`,
  );
  lines.push(
    `last poll: ${status.lastPollAt ? agoShort(status.lastPollAt, now) : "never"} · ` +
      `last success: ${status.lastSuccessAt ? agoShort(status.lastSuccessAt, now) : "never"}`,
  );
  if (status.lastError) {
    lines.push(`last error (${agoShort(status.lastError.at, now)} ago): ${status.lastError.message}`);
  }
  lines.push("");
  lines.push(`recent logs (${capture.size()} lines, redacted):`);

  const logs = capture.lines();
  if (logs.length === 0) {
    lines.push("(no log lines captured)");
  }
  for (const line of logs) {
    lines.push(`+${agoShort(line.at, now)} [${line.level}] ${line.text}`);
  }

  let text = lines.join("\n");
  // Final safety net: the summary interpolates poller state (last error
  // messages can quote a rejected API URL, which may embed the token). One
  // redaction pass over the whole render guarantees the export is clean even
  // if a future call site forgets.
  text = redactLine(text, secretsFor(config));
  if (text.length > MAX_EXPORT_CHARS) {
    // Keep the summary (the head) and the newest logs (the tail of `lines`).
    // Trim from the middle of the rendered text: the head is the summary, the
    // tail is the most recent log lines.
    const head = text.slice(0, 2_000);
    const tailBudget = MAX_EXPORT_CHARS - head.length - 40;
    const tail = text.slice(text.length - tailBudget);
    text = `${head}\n…[older log lines omitted]…\n${tail}`;
  }
  return text;
}
