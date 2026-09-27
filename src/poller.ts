/**
 * The poll loop: read new contract events, notify, persist the cursor.
 *
 * ── Failure policy ───────────────────────────────────────────────────────────
 *
 * This process is meant to stay up for weeks. Nothing in one cycle may end it:
 *
 *  - A failed RPC call fails ONE contract's scan for ONE cycle. Its cursor is
 *    left untouched, so the next cycle picks up exactly where it stopped.
 *  - A failed Telegram send drops ONE message. The cursor still advances.
 *    That is deliberate: holding the cursor back on a send failure means a
 *    broken bot token or a chat the bot was kicked from turns into an infinite
 *    replay of the same events forever, and recovering floods the channel.
 *    Notifications are lossy by design; the chain remains the record.
 *  - A cursor file that cannot be read is treated as a cold start; one that
 *    cannot be written is logged, and the in-memory cursor keeps working until
 *    the next restart.
 *  - A cursor file with an unrecognised or missing version is treated as a cold
 *    start rather than silently misread.
 *  - A cursor whose ledger is far behind the RPC's retained floor triggers a
 *    warning, because events in the gap will never be posted.
 *  - Consecutive full-cycle failures are counted; a structured warning is
 *    emitted at thresholds so an operator can act before the bot falls silent.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { rpc } from "@stellar/stellar-sdk";

import type { BotConfig } from "./config.js";
import { clip, formatEvent } from "./notifications/format.js";
import { eventCursorLedger, readContractEvents, type WatchTarget } from "./stellar/events.js";
import type { ContractSource, DecodedEvent } from "./stellar/decode.js";
import type { Metrics } from "./metrics.js";

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
  /**
   * Optional metrics registry. When provided, the poller increments counters
   * on every observable event. When absent (e.g. in tests that don't need it),
   * the poller behaves identically but emits no metrics.
   */
  metrics?: Metrics | undefined;
}

/**
 * How many ledgers a cursor can lag behind the retained floor before the poller
 * warns. Events in the gap are already gone — this threshold makes the operator
 * aware before the lag grows indefinitely.
 *
 * 10 % of the approximate Testnet window (~120 960 ledgers ≈ a week).
 */
const STALE_CURSOR_LEDGER_LAG = 12_096;

/**
 * Consecutive-failure thresholds at which a structured warning is emitted.
 * The thresholds are deliberately non-linear so that short transient glitches
 * (1–4 cycles) are silent, a medium outage (5+) is visible, and a long outage
 * (10+) is highlighted loudly.
 */
const CONSECUTIVE_FAILURE_THRESHOLDS = [5, 10, 25, 50, 100];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createPoller(deps: PollerDeps) {
  const { config, server, send } = deps;
  const metrics = deps.metrics;

  const targets: WatchTarget[] = [
    { source: "market", contractId: config.marketContractId },
    { source: "squad", contractId: config.squadContractId },
  ];

  const state = new Map<ContractSource, TargetState>(
    targets.map((t) => [
      t.source,
      {
        source: t.source,
        contractId: t.contractId,
        cursor: null,
        lastEventLedger: null,
        lastError: null,
      },
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

  // ── Cursor persistence ─────────────────────────────────────────────────────

  async function loadCursors(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(config.cursorFile, "utf8");
    } catch {
      console.log(
        `[poller] no cursor file at ${config.cursorFile}; cold start ` +
          `${config.startLookbackLedgers} ledgers behind the tip`,
      );
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<CursorFile>;

      // Version guard: if the field is absent or not 1, the file was written
      // by a different version of this code. Cold-starting is safer than
      // silently misreading an unknown layout.
      if (parsed.version === undefined) {
        console.warn(
          `[poller] cursor file at ${config.cursorFile} has no version field; ` +
            `cold-starting rather than risking a misread. Delete the file to suppress this.`,
        );
        return;
      }
      if (parsed.version !== 1) {
        console.warn(
          `[poller] cursor file version ${String(parsed.version)} is not supported ` +
            `(expected 1); cold-starting. Delete the file or downgrade to the matching release.`,
        );
        return;
      }

      for (const [source, saved] of Object.entries(parsed.targets ?? {})) {
        const target = state.get(source as ContractSource);
        if (!target) continue;
        target.cursor = saved.cursor ?? null;
        target.lastEventLedger = saved.lastEventLedger ?? null;
      }
      console.log(
        `[poller] resumed from ${config.cursorFile}: ` +
          [...state.values()].map((t) => `${t.source}@${t.cursor ?? "none"}`).join(" "),
      );
    } catch (err) {
      // A corrupt state file must not wedge the bot; a cold start is recoverable.
      console.warn(`[poller] cursor file unreadable, starting cold: ${errMessage(err)}`);
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
      console.error(`[poller] could not persist cursor: ${errMessage(err)}`);
    }
  }

  // ── Stale cursor detection ─────────────────────────────────────────────────

  /**
   * Warn when a persisted cursor points to a ledger that has already fallen
   * behind the retained floor. Events in that gap will never be delivered.
   * This can happen after a long outage or an accidental ephemeral filesystem.
   */
  function checkStaleCursors(oldestLedger: number): void {
    for (const target of state.values()) {
      if (!target.cursor) continue;
      const cursorLedger = eventCursorLedger(target.cursor);
      if (cursorLedger === null) continue;

      const lag = oldestLedger - cursorLedger;
      if (lag > STALE_CURSOR_LEDGER_LAG) {
        console.warn(
          `[poller] STALE CURSOR — ${target.source} cursor is at ledger ${cursorLedger}, ` +
            `but the RPC only retains from ledger ${oldestLedger} ` +
            `(${lag} ledgers behind, ~${Math.round((lag * 5) / 60)} minutes of events lost). ` +
            `Events in the gap will not be posted. ` +
            `Delete ${config.cursorFile} to cold-start and resume from the current tip.`,
        );
        metrics?.staleCursorEvents.inc();
      }
    }
  }

  // ── One cycle ──────────────────────────────────────────────────────────────

  async function notify(events: DecodedEvent[]): Promise<void> {
    let sentThisCycle = 0;

    for (const event of events) {
      metrics?.eventsDecoded.inc();

      if (event.payload.name === "unknown") {
        status.eventsSkipped += 1;
        metrics?.eventsSkipped.inc();
        // Clip the event name and reason: these come from remote contract data
        // and must not produce unbounded log output.
        const safeName = clip(event.payload.eventName ?? "", 80);
        const safeReason = event.payload.reason ? ` (${clip(event.payload.reason, 120)})` : "";
        console.log(
          `[poller] skipped ${event.source} event "${safeName}" ` +
            `at ledger ${event.ledger}${safeReason}`,
        );
        continue;
      }

      const text = formatEvent(config, event);
      if (text === null) {
        status.eventsSkipped += 1;
        metrics?.eventsSkipped.inc();
        continue;
      }

      if (sentThisCycle >= config.maxNotificationsPerCycle) {
        status.eventsSkipped += 1;
        metrics?.eventsSkipped.inc();
        // Log clearly that the cap was reached, not just that an event was dropped.
        if (sentThisCycle === config.maxNotificationsPerCycle) {
          console.warn(
            `[poller] MAX_NOTIFICATIONS_PER_CYCLE cap (${config.maxNotificationsPerCycle}) reached ` +
              `this cycle — remaining events skipped. ` +
              `Raise MAX_NOTIFICATIONS_PER_CYCLE or wait for the next cycle. ` +
              `Cursor still advances; the chain is the record.`,
          );
        }
        continue;
      }

      try {
        await send(text);
        status.notificationsSent += 1;
        metrics?.notificationsSent.inc();
        sentThisCycle += 1;
      } catch (err) {
        // One bad send must not abort the rest of the batch.
        status.notificationsFailed += 1;
        metrics?.notificationsFailed.inc();
        console.error(
          `[poller] send failed for ${event.payload.name} at ledger ${event.ledger}: ` +
            errMessage(err),
        );
      }

      // Pace sends to stay under Telegram's ~20 messages/minute limit.
      // interSendDelayMs is configurable via INTER_SEND_DELAY_MS.
      if (sentThisCycle < config.maxNotificationsPerCycle && config.interSendDelayMs > 0) {
        await sleep(config.interSendDelayMs);
      }
    }
  }

  async function cycle(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    status.cycles += 1;
    status.lastPollAt = Date.now();
    metrics?.pollCycles.inc();

    let anyOk = false;

    for (const target of targets) {
      const current = state.get(target.source);
      if (!current) continue;

      try {
        const scan = await readContractEvents(server, target, {
          cursor: current.cursor ?? undefined,
          lookbackLedgers: current.cursor ? undefined : config.startLookbackLedgers,
        });

        status.latestLedger = scan.latestLedger;
        status.oldestLedger = scan.oldestLedger;
        current.lastError = null;
        anyOk = true;
        metrics?.rpcRequests.inc();

        // Warn if this cursor is already behind the RPC's retention window.
        checkStaleCursors(scan.oldestLedger);

        if (scan.events.length > 0) {
          console.log(
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
        metrics?.rpcErrors.inc();
        console.error(`[poller] ${target.source} scan failed: ${message}`);
      }
    }

    if (anyOk) {
      status.lastSuccessAt = Date.now();
      status.consecutiveFailures = 0;
      metrics?.consecutiveFailures.set(0);
    } else {
      status.consecutiveFailures += 1;
      metrics?.consecutiveFailures.set(status.consecutiveFailures);
      emitCircuitBreakerWarning();
    }

    status.targets = [...state.values()].map((t) => ({ ...t }));
    await saveCursors();
    inFlight = false;
  }

  /**
   * Emit a structured warning at each consecutive-failure threshold.
   * The warning is emitted exactly once per threshold crossing (not every cycle),
   * which makes it grep-able and avoids log spam during a long outage.
   */
  function emitCircuitBreakerWarning(): void {
    const n = status.consecutiveFailures;
    if (!CONSECUTIVE_FAILURE_THRESHOLDS.includes(n)) return;

    const lastMsg = status.lastError?.message ?? "unknown";
    // Clip the error message: it could contain unbounded RPC response text.
    const safeMsg = clip(lastMsg, 200);
    console.warn(
      `[poller] CONSECUTIVE FAILURES: ${n} full cycles failed in a row. ` +
        `Last error: ${safeMsg}. ` +
        `Check RPC connectivity (${config.rpcUrl}) and Telegram bot status. ` +
        `The cursor is safe; the bot will resume automatically when the error clears.`,
    );
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await cycle();
    } catch (err) {
      // Belt and braces: `cycle` already swallows per-target failures, so this
      // only fires on a bug. Either way the loop survives it.
      status.consecutiveFailures += 1;
      metrics?.consecutiveFailures.set(status.consecutiveFailures);
      emitCircuitBreakerWarning();
      status.lastError = { at: Date.now(), message: errMessage(err) };
      console.error(`[poller] cycle threw: ${errMessage(err)}`);
      inFlight = false;
    }
    if (stopped) return;
    timer = setTimeout(() => void loop(), config.pollIntervalMs);
  }

  return {
    async start(): Promise<void> {
      await loadCursors();
      status.running = true;
      status.startedAt = Date.now();
      status.targets = [...state.values()].map((t) => ({ ...t }));
      console.log(
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
