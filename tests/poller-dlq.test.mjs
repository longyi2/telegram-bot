/**
 * Dead-letter queue, driven through the real poller.
 *
 * `tests/deadLetter.test.mjs` covers the queue in isolation; this covers the two
 * integration points that matter: a send that exhausts its retries is parked
 * (instead of dropped) while the cursor still advances, and the next cycle
 * replays what was parked once Telegram recovers.
 *
 * Offline and deterministic: fake RPC server, fake Telegram send, a throwaway
 * data directory, and no waiting on production backoff (retries and spacing are
 * configured to 0).
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import { createPoller } from "../dist/poller.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

const dataDir = await createTempDataDir("mimir-dlq-poller-");
test.after(() => dataDir.cleanup());

const BOT_TOKEN = "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

const scStr = (s) => nativeToScVal(s, { type: "string" });
const scU64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const scAddress = (g) =>
  Address.account(Buffer.from(Keypair.fromPublicKey(g).rawPublicKey())).toScVal();
const ADDR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42)).publicKey();

const cursorFor = (ledger) => `${BigInt(ledger) << 32n}-0`;

/** A claim_created event, which is notifiable, so it reaches the send path. */
function eventAt(ledger) {
  return [
    {
      contractId: MARKET_ID,
      ledger,
      txHash: "abc",
      ledgerClosedAt: "2026-01-01T00:00:00Z",
      id: `${ledger}-0`,
      topic: [scStr("claim_created"), scU64(ledger), scAddress(ADDR)],
      value: nativeToScVal({ category: "crypto" }),
    },
  ];
}

/** Fake RPC: one fresh notifiable market event per scan, squad always empty. */
function makeServer() {
  let ledger = 5_000;
  return {
    async getHealth() {
      return { status: "healthy", oldestLedger: 4_000, latestLedger: ledger };
    },
    async getEvents(req) {
      const id = req.filters?.[0]?.contractIds?.[0];
      if (id !== MARKET_ID) {
        return { events: [], cursor: cursorFor(ledger), latestLedger: ledger };
      }
      ledger += 1;
      return { events: eventAt(ledger), cursor: cursorFor(ledger), latestLedger: ledger };
    },
  };
}

function baseConfig(dir, overrides = {}) {
  return {
    botToken: BOT_TOKEN,
    chatId: "-1001234567890",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    pollIntervalMs: 40,
    startLookbackLedgers: 60,
    cursorFile: dir.file("cursor.json"),
    lockFile: dir.file("poller.lock"),
    maxNotificationsPerCycle: 20,
    deadLetterFile: dir.file("dead-letter.json"),
    deadLetterMax: 3,
    deadLetterMaxAttempts: 3,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

/** Retries and spacing at 0: a failure must reach the queue on the first try. */
const FAST_SEND = {
  sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
};

async function waitFor(cond, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Parking ───────────────────────────────────────────────────────────────────

test("dlq: a send that exhausts its retries is parked and the cursor still advances", async () => {
  const dir = await createTempDataDir("mimir-dlq-park-");
  const poller = createPoller({
    config: baseConfig(dir),
    server: makeServer(),
    send: async () => {
      throw new Error(`Telegram unavailable for https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    },
    ...FAST_SEND,
  });

  try {
    await poller.start();
    await waitFor(() => poller.status().deadLetter.depth >= 1);
    const status = poller.status();
    assert.ok(status.notificationsFailed >= 1, "the failure is still counted");
    assert.equal(status.deadLetter.enqueued, status.deadLetter.depth);

    // The chain is the source of truth: the cursor advanced past the event the
    // parked message came from, so the queue can never wedge the poller. The
    // cycle writes it after the batch, so wait for the write, not just the park.
    await waitFor(() => existsSync(dir.file("cursor.json")));
    const cursor = JSON.parse(await readFile(dir.file("cursor.json"), "utf8"));
    assert.ok(cursor.targets.market.cursor !== null, "market cursor advanced");

    const parked = JSON.parse(await readFile(dir.file("dead-letter.json"), "utf8"));
    assert.equal(parked.entries.length, status.deadLetter.depth);
    assert.equal(parked.entries[0].source, "market");
    assert.ok(typeof parked.entries[0].text === "string" && parked.entries[0].text.length > 0);
    // The one thing that must never be persisted.
    assert.equal(JSON.stringify(parked).includes(BOT_TOKEN), false);
  } finally {
    await poller.stop();
    await dir.cleanup();
  }
});

test("dlq: the queue stays bounded when every cycle fails", async () => {
  const dir = await createTempDataDir("mimir-dlq-bound-");
  const poller = createPoller({
    config: baseConfig(dir), // deadLetterMax: 3
    server: makeServer(),
    send: async () => {
      throw new Error("Telegram down");
    },
    ...FAST_SEND,
  });

  try {
    await poller.start();
    await waitFor(() => poller.status().deadLetter.dropped >= 1);
    const status = poller.status();
    assert.ok(status.deadLetter.depth <= 3, `depth ${status.deadLetter.depth}`);
    assert.ok(status.deadLetter.dropped >= 1, "the oldest entry was dropped");
    const parked = JSON.parse(await readFile(dir.file("dead-letter.json"), "utf8"));
    assert.ok(parked.entries.length <= 3);
  } finally {
    await poller.stop();
    await dir.cleanup();
  }
});

// ── Replay ────────────────────────────────────────────────────────────────────

test("dlq: the next cycle replays a parked send once Telegram recovers", async () => {
  const dir = await createTempDataDir("mimir-dlq-replay-");
  let fail = true;
  const delivered = [];
  const poller = createPoller({
    config: baseConfig(dir),
    server: makeServer(),
    send: async (text, source) => {
      if (fail) throw new Error("Telegram down");
      delivered.push([source, text]);
    },
    ...FAST_SEND,
  });

  try {
    await poller.start();
    await waitFor(() => poller.status().deadLetter.depth >= 1);
    const parkedDepth = poller.status().deadLetter.depth;

    fail = false;
    await waitFor(() => poller.status().deadLetter.replayed >= 1);
    assert.ok(poller.status().deadLetter.depth < parkedDepth, "the queue drained");
    // Replayed to the chat the original attempt was routed to.
    assert.equal(
      delivered.some(([source]) => source === "market"),
      true,
    );
  } finally {
    await poller.stop();
    await dir.cleanup();
  }
});

test("dlq: parked sends survive a restart and drain on the next run", async () => {
  const dir = await createTempDataDir("mimir-dlq-restart-");
  const first = createPoller({
    config: baseConfig(dir),
    server: makeServer(),
    send: async () => {
      throw new Error("Telegram down");
    },
    ...FAST_SEND,
  });

  let parked = 0;
  try {
    await first.start();
    await waitFor(() => first.status().deadLetter.depth >= 1);
    parked = first.status().deadLetter.depth;
  } finally {
    await first.stop();
  }
  assert.ok(parked >= 1);

  const delivered = [];
  const second = createPoller({
    config: baseConfig(dir),
    server: makeServer(),
    send: async (text) => {
      delivered.push(text);
    },
    ...FAST_SEND,
  });
  try {
    await second.start();
    await waitFor(() => second.status().deadLetter.replayed >= 1);
    assert.ok(delivered.length >= 1, "the parked message was sent after the restart");
  } finally {
    await second.stop();
    await dir.cleanup();
  }
});

// ── Disabled ──────────────────────────────────────────────────────────────────

test("dlq: with no deadLetterFile the poller behaves exactly as before", async () => {
  const dir = await createTempDataDir("mimir-dlq-off-");
  const config = baseConfig(dir);
  delete config.deadLetterFile;
  delete config.deadLetterMax;
  delete config.deadLetterMaxAttempts;

  const poller = createPoller({
    config,
    server: makeServer(),
    send: async () => {
      throw new Error("Telegram down");
    },
    ...FAST_SEND,
  });

  try {
    await poller.start();
    await waitFor(() => poller.status().notificationsFailed >= 1);
    // A config that predates the queue keeps main's behaviour: the failure is
    // counted and dropped, and nothing is written.
    assert.equal(poller.status().deadLetter.depth, 0);
    assert.equal(existsSync(dir.file("dead-letter.json")), false);
  } finally {
    await poller.stop();
    await dir.cleanup();
  }
});

test("dlq: a healthy send never touches the queue file", async () => {
  const dir = await createTempDataDir("mimir-dlq-healthy-");
  const poller = createPoller({
    config: baseConfig(dir),
    server: makeServer(),
    send: async () => {},
    ...FAST_SEND,
  });

  try {
    await poller.start();
    await waitFor(() => poller.status().notificationsSent >= 1);
    assert.equal(poller.status().deadLetter.depth, 0);
    assert.equal(poller.status().deadLetter.enqueued, 0);
    assert.equal(poller.status().notificationsFailed, 0);
    assert.equal(existsSync(dir.file("dead-letter.json")), false);
  } finally {
    await poller.stop();
    await dir.cleanup();
  }
});
