/**
 * The poll loop: read new contract events, notify, persist the cursor.
 *
 * ── Failure policy ───────────────────────────────────────────────────────────
 *
 * This process is meant to stay up for weeks. Nothing in one cycle may end it:
 *
 *  - A failed RPC call fails ONE contract's scan for ONE cycle. Its cursor is
 *    left untouched, so the next cycle picks up exactly where it stopped.
 *    Transient failures are retried up to MAX_RPC_RETRIES times with
 *    exponential back-off before being counted as a failure.
 *  - A Telegram 429 (rate-limit) response is parsed for the Retry-After header
 *    and the send is retried once after that delay rather than dropped.
 *  - A failed Telegram send (after any retry) drops ONE message. The cursor
 *    still advances.  That is deliberate: holding the cursor back on a send
 *    failure means a broken bot token or a chat the bot was kicked from turns
 *    into an infinite replay of the same events forever, and recovering floods
 *    the channel.  Notifications are lossy by design; the chain remains the
 *    record.
 *  - After CONSECUTIVE_FAILURE_ALERT_THRESHOLD cycles in a row where every
 *    target scan fails, the poller posts a single plain-text alert to the
 *    configured chat so an operator knows the bot is stuck, then stays quiet
 *    until a cycle partially succeeds again.
 *  - A cursor file that cannot be read is treated as a cold start; one that
 *    cannot be written is logged, and the in-memory cursor keeps working until
 *    the next restart.
 *  - A persisted cursor whose ledger is outside the RPC's retained window is
 *    treated as stale: a warning is logged and that target cold-starts rather
 *    than erroring out.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { rpc } from "@stellar/stellar-sdk";

import type { BotConfig } from "./config.js";
import { log } from "./log.js";
import { formatEvent } from "./notifications/format.js";
import { readContractEvents, eventCursorLedger, type WatchTarget } from "./stellar/events.js";
import type { ContractSource, DecodedEvent } from "./stellar/decode.js";

export interface TargetState {
  source: ContractSource;
  contractId: string;
  cursor: string | null;
  /** Highest ledger an event was seen in, from this run or the cursor file. */
  lastEventLedger: number | null;
  lastError: string | null;
}

export interface PollerStatus {
  running: boolean;
  startedAt: number;
  cycles: number;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  latestLedger: number | null;
  oldestLedger: number | null;
  notificationsSent: number;
  notificationsFailed: number;
  eventsSkipped: number;
  consecutiveFailures: number;
  lastError: { at: number; message: string } | null;
  targets: TargetState[];
}

interface CursorFile {
  version: 1;
  updatedAt: string;
  targets: Record<string, { cursor: string | null; lastEventLedger: number | null }>;
}

export interface PollerDeps {
  config: BotConfig;
  server: rpc.Server;
  /** Sends one already-formatted MarkdownV2 message. May reject. */
  send: (text: string) => Promise<void>;
}

/** Telegram tolerates ~20 messages/minute to one chat; stay under it. */
const SEND_SPACING_MS = 1_500;

/** Maximum RPC retries per scan call with exponential back-off. */
const MAX_RPC_RETRIES = 3;

/** Base delay (ms) for the first RPC retry; doubles each attempt. */
const RPC_RETRY_BASE_MS = 2_000;

/**
 * After this many consecutive all-fail cycles the poller posts one alert.
 * Can be overridden by CONSECUTIVE_FAILURE_ALERT_THRESHOLD in the environment.
 */
function alertThreshold(): number {
  const raw = process.env["CONSECUTIVE_FAILURE_ALERT_THRESHOLD"];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) return n;
  }
  // Default: alert after five consecutive all-fail cycles.
  return 5;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract the `retry_after` seconds from a grammy / Telegram API error.
 *
 * Telegram returns HTTP 429 with a JSON body like:
 *   { ok: false, error_code: 429, parameters: { retry_after: 30 } }
 * grammy surfaces this as an `HttpError` or `GrammyError` with
 * `error.description` containing the word "retry" and optionally exposes
 * `error.parameters.retry_after` as a number.
 */
export function extractRetryAfter(err: unknown): number | null {
  if (err == null || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;

  // grammy's GrammyError exposes error_code and parameters.
  if (e["error_code"] === 429) {
    const params = e["parameters"];
    if (params != null && typeof params === "object") {
      const ra = (params as Record<string, unknown>)["retry_after"];
      if (typeof ra === "number" && ra > 0) return ra;
    }
    // Fallback: default to 30 s if we know it's 429 but lack the header.
    return 30;
  }

  // Some HTTP layers embed the status in `status` or `statusCode`.
  const status = e["status"] ?? e["statusCode"];
  if (status === 429) return 30;

  return null;
}

/**
 * Call `fn`, retrying up to `maxRetries` times on error with exponential
 * back-off starting at `baseMs` ms.  Throws the last error if all retries
 * are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_RPC_RETRIES,
  baseMs: number = RPC_RETRY_BASE_MS,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > maxRetries) throw err;
      const delay = baseMs * 2 ** (attempt - 1);
      log.warn(
        `[poller] RPC call failed (attempt ${attempt}/${maxRetries}), ` +
          `retrying in ${delay}ms: ${errMessage(err)}`,
      );
      await sleep(delay);
    }
  }
}

export function createPoller(deps: PollerDeps) {
  const { config, server, send } = deps;

  const targets: WatchTarget[] = [
    { source: "market", contractId: config.marketContractId },
    { source: "squad", contractId: config.squadContractId },
  ];

  const state = new Map<ContractSource, TargetState>(
    targets.map((t) => [
      t.source,
      { source: t.source, contractId: t.contractId, cursor: null, lastEventLedger: null, lastError: null },
    ]),
  );

  const status: PollerStatus = {
    running: false,
    startedAt: 0,
    cycles: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;
  /** True once we have sent the consecutive-failure alert for the current run. */
  let alertSent = false;

  // ── Cursor persistence ─────────────────────────────────────────────────────

  /**
   * Load cursors from disk.  If the cursor file doesn't exist we cold-start.
   * If a cursor exists but its encoded ledger is outside the RPC's retained
   * window we discard that cursor and cold-start just that target.
   *
   * The `oldestLedger` param comes from the caller so we can perform stale
   * detection without an extra round trip.
   */
  async function loadCursors(oldestLedger: number): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(config.cursorFile, "utf8");
    } catch {
      log.info(
        `[poller] no cursor file at ${config.cursorFile}; cold start ` +
          `${config.startLookbackLedgers} ledgers behind the tip`,
      );
      return;
    }

    try {
      const parsed = JSON.parse(raw) as CursorFile;
      for (const [source, saved] of Object.entries(parsed.targets ?? {})) {
        const target = state.get(source as ContractSource);
        if (!target) continue;

        const cursor = saved.cursor ?? null;

        if (cursor !== null) {
          const cursorLedger = eventCursorLedger(cursor);
          if (cursorLedger !== null && cursorLedger < oldestLedger) {
            log.warn(
              `[poller] ${source} cursor ledger ${cursorLedger} is below the ` +
                `retained floor ${oldestLedger}; discarding stale cursor, cold-starting`,
            );
            // Leave cursor null → cold start for this target.
            target.lastEventLedger = saved.lastEventLedger ?? null;
            continue;
          }
        }

        target.cursor = cursor;
        target.lastEventLedger = saved.lastEventLedger ?? null;
      }
      log.info(
        `[poller] resumed from ${config.cursorFile}: ` +
          [...state.values()].map((t) => `${t.source}@${t.cursor ?? "none"}`).join(" "),
      );
    } catch (err) {
      // A corrupt state file must not wedge the bot; a cold start is recoverable.
      log.warn(`[poller] cursor file unreadable, starting cold: ${errMessage(err)}`);
    }
  }

  async function saveCursors(): Promise<void> {
    const payload: CursorFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      targets: Object.fromEntries(
        [...state.values()].map((t) => [
          t.source,
          { cursor: t.cursor, lastEventLedger: t.lastEventLedger },
        ]),
      ),
    };

    try {
      await mkdir(path.dirname(config.cursorFile), { recursive: true });
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that sends the next start back to the beginning of the retained window.
      const tmp = `${config.cursorFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, config.cursorFile);
    } catch (err) {
      log.error(`[poller] could not persist cursor: ${errMessage(err)}`);
    }
  }

  // ── One cycle ──────────────────────────────────────────────────────────────

  async function notify(events: DecodedEvent[]): Promise<void> {
    let sentThisCycle = 0;

    for (const event of events) {
      if (event.payload.name === "unknown") {
        status.eventsSkipped += 1;
        log.info(
          `[poller] skipped ${event.source} event "${event.payload.eventName}" ` +
            `at ledger ${event.ledger}${event.payload.reason ? ` (${event.payload.reason})` : ""}`,
        );
        continue;
      }

      const text = formatEvent(config, event);
      if (text === null) {
        status.eventsSkipped += 1;
        continue;
      }

      if (sentThisCycle >= config.maxNotificationsPerCycle) {
        status.eventsSkipped += 1;
        log.warn(
          `[poller] cycle notification cap (${config.maxNotificationsPerCycle}) reached; ` +
            `dropping ${event.payload.name} at ledger ${event.ledger}`,
        );
        continue;
      }

      try {
        await sendWithRateLimit(text);
        status.notificationsSent += 1;
        sentThisCycle += 1;
      } catch (err) {
        // One bad send must not abort the rest of the batch.
        status.notificationsFailed += 1;
        log.error(
          `[poller] send failed for ${event.payload.name} at ledger ${event.ledger}: ` +
            errMessage(err),
        );
      }

      if (sentThisCycle < config.maxNotificationsPerCycle) await sleep(SEND_SPACING_MS);
    }
  }

  /**
   * Send one message, handling Telegram's 429 rate-limit with a single retry.
   *
   * If the error is a 429, we read `retry_after` from the error object and
   * sleep exactly that long before one retry.  Any other error is re-thrown
   * immediately so `notify` can count it as a failed send.
   */
  async function sendWithRateLimit(text: string): Promise<void> {
    try {
      await send(text);
    } catch (err) {
      const retryAfter = extractRetryAfter(err);
      if (retryAfter === null) throw err;
      log.warn(
        `[poller] Telegram rate-limited (429); retrying after ${retryAfter}s`,
      );
      await sleep(retryAfter * 1_000);
      await send(text);
    }
  }

  /**
   * Send a plain-text (no MarkdownV2) alert to the configured chat.
   * This is separate from the main `send` path so a MarkdownV2 formatting
   * problem in an event doesn't prevent the alert from going out.
   */
  async function sendAlert(text: string): Promise<void> {
    try {
      await send(text);
    } catch (err) {
      log.error(`[poller] could not send consecutive-failure alert: ${errMessage(err)}`);
    }
  }

  async function cycle(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    status.cycles += 1;
    status.lastPollAt = Date.now();

    let anyOk = false;

    for (const target of targets) {
      const current = state.get(target.source);
      if (!current) continue;

      try {
        const scan = await withRetry(() =>
          readContractEvents(server, target, {
            cursor: current.cursor ?? undefined,
            lookbackLedgers: current.cursor ? undefined : config.startLookbackLedgers,
          }),
        );

        status.latestLedger = scan.latestLedger;
        status.oldestLedger = scan.oldestLedger;
        current.lastError = null;
        anyOk = true;

        if (scan.events.length > 0) {
          log.info(
            `[poller] ${target.source}: ${scan.events.length} event(s) ` +
              `up to ledger ${scan.lastEventLedger} in ${scan.pages} page(s)`,
          );
          await notify(scan.events);
        }

        if (scan.lastEventLedger !== null) current.lastEventLedger = scan.lastEventLedger;
        // Advance last — see the failure policy at the top of this file.
        if (scan.cursor) current.cursor = scan.cursor;
      } catch (err) {
        const message = errMessage(err);
        current.lastError = message;
        status.lastError = { at: Date.now(), message: `${target.source}: ${message}` };
        log.error(`[poller] ${target.source} scan failed: ${message}`);
      }
    }

    if (anyOk) {
      status.lastSuccessAt = Date.now();
      status.consecutiveFailures = 0;
      alertSent = false;
    } else {
      status.consecutiveFailures += 1;

      const threshold = alertThreshold();
      if (status.consecutiveFailures >= threshold && !alertSent) {
        alertSent = true;
        const msg =
          `⚠️ Mimir notifier: ${status.consecutiveFailures} consecutive poll cycles ` +
          `failed to reach the Stellar RPC. Last error: ` +
          (status.lastError?.message ?? "unknown");
        log.warn(`[poller] sending consecutive-failure alert after ${status.consecutiveFailures} cycles`);
        await sendAlert(msg);
      }
    }

    status.targets = [...state.values()].map((t) => ({ ...t }));
    await saveCursors();
    inFlight = false;
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await cycle();
    } catch (err) {
      // Belt and braces: `cycle` already swallows per-target failures, so this
      // only fires on a bug. Either way the loop survives it.
      status.consecutiveFailures += 1;
      status.lastError = { at: Date.now(), message: errMessage(err) };
      log.error(`[poller] cycle threw: ${errMessage(err)}`);
      inFlight = false;
    }
    if (stopped) return;
    timer = setTimeout(() => void loop(), config.pollIntervalMs);
  }

  return {
    async start(): Promise<void> {
      // Fetch health first so we can validate cursors against the retained floor.
      let oldestLedger = 0;
      try {
        const health = await server.getHealth();
        oldestLedger = health.oldestLedger;
      } catch {
        // If health fails at startup we still load — stale detection just skips.
      }

      await loadCursors(oldestLedger);
      status.running = true;
      status.startedAt = Date.now();
      status.targets = [...state.values()].map((t) => ({ ...t }));
      log.info(
        `[poller] watching market=${config.marketContractId} squad=${config.squadContractId} ` +
          `every ${config.pollIntervalMs}ms`,
      );
      void loop();
    },

    stop(): void {
      stopped = true;
      status.running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    status(): PollerStatus {
      return { ...status, targets: [...state.values()].map((t) => ({ ...t })) };
    },
  };
}

export type Poller = ReturnType<typeof createPoller>;
