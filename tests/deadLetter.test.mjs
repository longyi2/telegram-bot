/**
 * Tests for src/deadLetter.ts.
 *
 * The queue sits between the poller and a file on disk, so every case here is
 * about a boundary: bounded depth, bounded attempts, bounded text, a truncated
 * and redacted error, and a file that is missing, corrupt, or absent by
 * configuration. No Telegram, no RPC, no repo `data/` directory.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { createDeadLetterQueue, makeEntryId } from "../dist/deadLetter.js";

const BOT_TOKEN = "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

async function withQueue(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-dlq-"));
  const filePath = path.join(directory, "dead-letter.json");
  let clock = 1_700_000_000_000;
  const queue = createDeadLetterQueue({
    filePath,
    maxEntries: options.maxEntries ?? 3,
    maxAttempts: options.maxAttempts ?? 3,
    now: () => clock,
  });
  try {
    await queue.load();
    return await run({
      queue,
      filePath,
      directory,
      tick: (ms = 1_000) => {
        clock += ms;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const parked = (ledger, text = "cancelled message", error = "Telegram 429") => ({
  source: "market",
  ledger,
  eventName: "claim_cancelled",
  text,
  error,
});

// ── Persistence and restart ───────────────────────────────────────────────────

test("enqueue persists a parked send and a fresh queue reads it back", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-dlq-restart-"));
  const filePath = path.join(directory, "dead-letter.json");
  try {
    const first = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => 1_700_000_000_000,
    });
    await first.load();
    await first.enqueue({
      source: "market",
      ledger: 42,
      eventName: "claim_cancelled",
      text: "cancelled message",
      error: new Error("Telegram 429"),
    });
    assert.equal(first.stats().depth, 1);
    assert.equal(first.stats().enqueued, 1);

    const raw = await readFile(filePath, "utf8");
    assert.match(raw, /"version": 1/);
    assert.match(raw, /claim_cancelled/);
    // Write-then-rename leaves no temporary file behind.
    await assert.rejects(() => stat(`${filePath}.tmp`));

    const second = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => 1_700_000_001_000,
    });
    await second.load();
    assert.equal(second.stats().depth, 1);
    assert.equal(second.snapshot()[0].ledger, 42);
    assert.equal(second.snapshot()[0].text, "cancelled message");
    // A restart resets the counters but not the queue.
    assert.equal(second.stats().enqueued, 0);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a missing file is a cold start, not an error", async () => {
  await withQueue(async ({ queue }) => {
    assert.equal(queue.stats().depth, 0);
  });
});

test("a corrupt queue file starts empty without throwing", async () => {
  await withQueue(async ({ queue, filePath }) => {
    await writeFile(filePath, "{not-json", "utf8");
    await queue.load();
    assert.equal(queue.stats().depth, 0);
    await queue.enqueue(parked(7));
    assert.equal(queue.stats().depth, 1);
  });
});

test("an unknown schema version is treated as corrupt, not parsed", async () => {
  await withQueue(async ({ queue, filePath }) => {
    await writeFile(filePath, JSON.stringify({ version: 99, entries: [parked(1)] }), "utf8");
    await queue.load();
    assert.equal(queue.stats().depth, 0);
  });
});

test("entries that are not shaped like entries are dropped on load", async () => {
  await withQueue(async ({ queue, filePath }) => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        entries: [
          { id: "a", text: "keep", ledger: 1 },
          { id: 2, text: "drop (id is not a string)", ledger: 2 },
          { id: "c", ledger: 3 },
          null,
        ],
      }),
      "utf8",
    );
    await queue.load();
    assert.equal(queue.stats().depth, 1);
    assert.equal(queue.snapshot()[0].id, "a");
  });
});

test("loading a hand-edited oversized file drops the excess oldest first", async () => {
  await withQueue(async ({ queue, filePath }) => {
    const entries = [1, 2, 3, 4, 5].map((ledger) => ({
      ...parked(ledger, `msg-${ledger}`),
      id: `market:${ledger}:claim_cancelled:00000000`,
      enqueuedAt: "2026-01-01T00:00:00.000Z",
      attempts: 1,
      lastError: null,
    }));
    await writeFile(filePath, JSON.stringify({ version: 1, updatedAt: "", entries }), "utf8");
    await queue.load();
    assert.equal(queue.stats().depth, 3);
    assert.deepEqual(queue.snapshot().map((e) => e.ledger), [3, 4, 5]);
    assert.equal(queue.stats().dropped, 2);
  }, { maxEntries: 3 });
});

// ── Disabled queue ────────────────────────────────────────────────────────────

test("filePath null keeps the queue in memory and touches no file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-dlq-off-"));
  try {
    const queue = createDeadLetterQueue({
      filePath: null,
      maxEntries: 5,
      maxAttempts: 3,
      now: () => 1_700_000_000_000,
    });
    await queue.load();
    await queue.enqueue(parked(1));
    assert.equal(queue.stats().depth, 1);

    const sent = [];
    const result = await queue.flush(async (text) => {
      sent.push(text);
    }, 10);
    assert.equal(result.sent, 1);
    assert.deepEqual(sent, ["cancelled message"]);
    // Nothing was written: the only file in the directory would be one we made.
    await assert.rejects(() => stat(path.join(directory, "dead-letter.json")));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── Flush ─────────────────────────────────────────────────────────────────────

test("flush replays oldest first and removes what was accepted", async () => {
  await withQueue(async ({ queue }) => {
    await queue.enqueue(parked(1, "one"));
    await queue.enqueue(parked(2, "two"));

    const sent = [];
    const result = await queue.flush(async (text) => {
      sent.push(text);
    }, 10);

    assert.deepEqual(sent, ["one", "two"]);
    assert.equal(result.sent, 2);
    assert.equal(result.remaining, 0);
    assert.equal(queue.stats().replayed, 2);
    assert.equal(queue.stats().depth, 0);
  });
});

test("flush respects its budget and keeps the remainder in order", async () => {
  await withQueue(async ({ queue }) => {
    await queue.enqueue(parked(1, "one"));
    await queue.enqueue(parked(2, "two"));

    const sent = [];
    const result = await queue.flush(async (text) => {
      sent.push(text);
    }, 1);

    assert.deepEqual(sent, ["one"]);
    assert.equal(result.sent, 1);
    assert.equal(result.remaining, 1);
    assert.equal(queue.snapshot()[0].text, "two");
  });
});

test("a zero budget replays nothing", async () => {
  await withQueue(async ({ queue }) => {
    await queue.enqueue(parked(1));
    const result = await queue.flush(async () => {
      throw new Error("must not be called");
    }, 0);
    assert.equal(result.sent, 0);
    assert.equal(result.remaining, 1);
  });
});

test("the callback sees the entry, so the destination survives the round trip", async () => {
  await withQueue(async ({ queue }) => {
    await queue.enqueue({ ...parked(5, "squad message"), source: "squad" });
    const seen = [];
    await queue.flush(async (text, entry) => {
      seen.push([entry.source, entry.eventName, text]);
    }, 10);
    assert.deepEqual(seen, [["squad", "claim_cancelled", "squad message"]]);
  });
});

test("a failed replay increments attempts and a poison entry is dropped at maxAttempts", async () => {
  await withQueue(async ({ queue }) => {
    await queue.enqueue(parked(9, "poison", "first"));
    // attempts starts at 1 from enqueue; maxAttempts=3 → drop after two failures.
    await queue.flush(async () => {
      throw new Error("still down");
    }, 10);
    assert.equal(queue.stats().depth, 1);
    assert.equal(queue.snapshot()[0].attempts, 2);

    const result = await queue.flush(async () => {
      throw new Error("still down");
    }, 10);
    assert.equal(result.remaining, 0);
    assert.equal(queue.stats().depth, 0);
    assert.equal(queue.stats().dropped, 1);
    assert.equal(queue.stats().replayed, 0);
  }, { maxAttempts: 3 });
});

test("a failed replay keeps its position while its neighbour is removed", async () => {
  await withQueue(async ({ queue }) => {
    await queue.enqueue(parked(1, "one"));
    await queue.enqueue(parked(2, "two"));
    await queue.enqueue(parked(3, "three"));
    await queue.flush(async (text) => {
      if (text === "one") throw new Error("one is still failing");
    }, 10);
    // "two" and "three" were accepted; "one" is still parked, first in line for
    // the next attempt rather than moved to the back.
    assert.deepEqual(queue.snapshot().map((e) => e.text), ["one"]);
    assert.equal(queue.stats().replayed, 2);
    assert.equal(queue.stats().depth, 1);
  });
});

// ── Bounds ────────────────────────────────────────────────────────────────────

test("the queue drops the oldest entry when full", async () => {
  await withQueue(async ({ queue }) => {
    for (let ledger = 1; ledger <= 4; ledger++) {
      await queue.enqueue(parked(ledger, `msg-${ledger}`));
    }
    assert.equal(queue.stats().depth, 3);
    assert.equal(queue.stats().dropped, 1);
    assert.deepEqual(
      queue.snapshot().map((e) => e.ledger),
      [2, 3, 4],
    );
  }, { maxEntries: 3 });
});

test("the same event failing twice is one entry with two attempts", async () => {
  await withQueue(async ({ queue }) => {
    await queue.enqueue(parked(11, "same body"));
    await queue.enqueue(parked(11, "same body"));
    assert.equal(queue.stats().depth, 1);
    assert.equal(queue.stats().enqueued, 1);
    assert.equal(queue.snapshot()[0].attempts, 2);
  });
});

test("a long message body is truncated before it is stored", async () => {
  await withQueue(async ({ queue, filePath }) => {
    await queue.enqueue(parked(1, "x".repeat(9_000)));
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    assert.ok(parsed.entries[0].text.length <= 4_001, `${parsed.entries[0].text.length}`);
    assert.equal(queue.snapshot()[0].text.endsWith("…"), true);
  });
});

// ── Redaction ─────────────────────────────────────────────────────────────────

test("a configured secret in an error is redacted, not merely truncated", async () => {
  // The realistic case: a Telegram send failure carries the token in the request
  // URL, and the queue is the last place it would ever be useful.
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-dlq-redact-"));
  const filePath = path.join(directory, "dead-letter.json");
  try {
    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 5,
      maxAttempts: 3,
      secrets: [BOT_TOKEN],
    });
    await queue.load();
    await queue.enqueue({
      ...parked(1),
      error: new Error(
        `call to https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed after 3 attempts`,
      ),
    });
    const raw = await readFile(filePath, "utf8");
    assert.equal(raw.includes(BOT_TOKEN), false);
    assert.equal(raw.includes("[REDACTED]"), true);
    assert.equal(queue.snapshot()[0].lastError.includes(BOT_TOKEN), false);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an unregistered token-shaped error is still caught by shape", async () => {
  await withQueue(async ({ queue, filePath }) => {
    // No secrets configured: the shape rule is the fallback, so a token pasted
    // into an error outside a `bot…` URL is still scrubbed.
    await queue.enqueue({ ...parked(2), error: `getMe failed for ${BOT_TOKEN}` });
    const raw = await readFile(filePath, "utf8");
    assert.equal(raw.includes(BOT_TOKEN), false);
    assert.equal(raw.includes("[REDACTED]"), true);
  });
});

test("a stored error is bounded even when redaction shortens it", async () => {
  await withQueue(async ({ queue, filePath }) => {
    await queue.enqueue({ ...parked(3), error: new Error(`fail-${"x".repeat(500)}`) });
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    assert.ok(parsed.entries[0].lastError.length <= 201, `${parsed.entries[0].lastError.length}`);
  });
});

// ── Persistence failures ──────────────────────────────────────────────────────

test("an unwritable queue logs and degrades instead of throwing", async () => {
  const warnings = [];
  const errors = [];
  mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  try {
    const queue = createDeadLetterQueue({
      // A directory can never be reopened as a file, so every persist fails.
      filePath: os.tmpdir(),
      maxEntries: 5,
      maxAttempts: 3,
    });
    await queue.load();
    const entry = await queue.enqueue(parked(1));
    assert.equal(entry.ledger, 1, "the entry is still queued in memory");
    assert.equal(queue.stats().depth, 1);
    assert.equal(
      errors.some((line) => line.includes("could not persist queue")),
      true,
    );
    assert.equal(
      warnings.some((line) => line.includes("parked")),
      true,
    );
  } finally {
    mock.restoreAll();
  }
});

test("makeEntryId is stable for identical payloads and differs on content", () => {
  const a = makeEntryId("market", 1, "claim_cancelled", "hello");
  const b = makeEntryId("market", 1, "claim_cancelled", "hello");
  const c = makeEntryId("market", 1, "claim_cancelled", "other");
  const d = makeEntryId("squad", 1, "claim_cancelled", "hello");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});
