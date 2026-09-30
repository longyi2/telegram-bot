import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPoller } from "../dist/poller.js";
import { paginatedGetEvents, EVENT_MAX_PAGES } from "../dist/stellar/events.js";

/**
 * Build a fake Soroban RPC server whose getEvents pages are scripted.
 * Each entry is either an empty page or a page with `count` dummy events.
 * Cursors advance as `c1`, `c2`, … and encode ledger tip progress via TOID.
 */
function fakeServer({ latestLedger = 1000, oldestLedger = 100, pages }) {
  let call = 0;
  return {
    async getHealth() {
      return { status: "healthy", latestLedger, oldestLedger };
    },
    async getEvents() {
      const idx = call;
      call += 1;
      const page = pages[idx];
      if (!page) {
        // No more scripted pages: return a stuck cursor so the walk ends.
        return {
          events: [],
          latestLedger,
          cursor: `c${idx}`,
        };
      }
      const events = Array.from({ length: page.events ?? 0 }, (_, i) => ({
        id: `${idx}-${i}`,
        type: "contract",
        ledger: page.ledger ?? latestLedger - 1,
        ledgerClosedAt: "2026-01-01T00:00:00Z",
        contractId: "C",
        topic: [],
        value: {},
        inSuccessfulContractCall: true,
        txHash: "ab",
      }));
      // Pack ledger into high 32 bits of TOID so eventCursorLedger can read it.
      const ledger = page.cursorLedger ?? latestLedger;
      const toid = (BigInt(ledger) << 32n).toString();
      return {
        events,
        latestLedger,
        cursor: `${toid}-0`,
      };
    },
  };
}

function ledgerCursor(ledger) {
  return `${(BigInt(ledger) << 32n).toString()}-0`;
}

test("paginatedGetEvents counts empty pages on a long quiet walk", async () => {
  // 12 empty pages then one with events at tip — mirrors the documented Testnet shape.
  const pages = [
    ...Array.from({ length: 12 }, (_, i) => ({
      events: 0,
      cursorLedger: 200 + i,
    })),
    { events: 3, cursorLedger: 1000 },
  ];
  const scan = await paginatedGetEvents(fakeServer({ pages }), [
    { type: "contract", contractIds: ["C"] },
  ]);

  assert.equal(scan.pages, 13);
  assert.equal(scan.emptyPages, 12);
  assert.equal(scan.events.length, 3);
  assert.equal(scan.truncated, false);
});

test("paginatedGetEvents reports zero empty pages when every page has events", async () => {
  const pages = [
    { events: 2, cursorLedger: 500 },
    { events: 1, cursorLedger: 1000 },
  ];
  const scan = await paginatedGetEvents(fakeServer({ pages }), [
    { type: "contract", contractIds: ["C"] },
  ]);

  assert.equal(scan.pages, 2);
  assert.equal(scan.emptyPages, 0);
  assert.equal(scan.events.length, 3);
});

test("paginatedGetEvents counts a single empty tip page", async () => {
  // One empty page whose cursor is already at the tip — walk ends immediately.
  const pages = [{ events: 0, cursorLedger: 1000 }];
  const scan = await paginatedGetEvents(fakeServer({ pages }), [
    { type: "contract", contractIds: ["C"] },
  ]);

  assert.equal(scan.pages, 1);
  assert.equal(scan.emptyPages, 1);
  assert.equal(scan.events.length, 0);
});

test("paginatedGetEvents still counts empty pages when maxPages truncates the walk", async () => {
  const pages = Array.from({ length: EVENT_MAX_PAGES + 5 }, (_, i) => ({
    events: 0,
    cursorLedger: 100 + i,
  }));
  const scan = await paginatedGetEvents(
    fakeServer({ latestLedger: 10_000, pages }),
    [{ type: "contract", contractIds: ["C"] }],
    { maxPages: 5 },
  );

  assert.equal(scan.pages, 5);
  assert.equal(scan.emptyPages, 5);
  assert.equal(scan.truncated, true);
});

test("paginatedGetEvents resumes from a cursor without inventing empty-page noise", async () => {
  const pages = [
    { events: 0, cursorLedger: 800 },
    { events: 1, cursorLedger: 1000 },
  ];
  const scan = await paginatedGetEvents(
    fakeServer({ pages }),
    [{ type: "contract", contractIds: ["C"] }],
    { cursor: ledgerCursor(700) },
  );

  assert.equal(scan.pages, 2);
  assert.equal(scan.emptyPages, 1);
  assert.equal(scan.events.length, 1);
});

test("poller status accumulates empty-page telemetry across cycles and targets", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mimir-poller-"));
  const cursorFile = path.join(tmp, "cursor.json");

  // Each target scan: 2 empty pages then tip. Two targets ⇒ 4 empty / 6 pages per cycle.
  let targetScans = 0;
  const server = {
    async getHealth() {
      return { status: "healthy", latestLedger: 5000, oldestLedger: 100 };
    },
    async getEvents() {
      // Three pages per target: empty, empty, tip.
      const within = targetScans % 3;
      targetScans += 1;
      const ledger = within === 2 ? 5000 : 1000 + targetScans;
      return {
        events: [],
        latestLedger: 5000,
        cursor: ledgerCursor(ledger),
      };
    },
  };

  const config = {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid",
    horizonUrl: "https://example.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0:fake",
    chatId: "-1001",
    pollIntervalMs: 60_000,
    startLookbackLedgers: 10,
    cursorFile,
    maxNotificationsPerCycle: 20,
  };

  const sent = [];
  const poller = createPoller({
    config,
    server,
    send: async (text) => {
      sent.push(text);
    },
  });

  // Drive one cycle without starting the timer loop: start() kicks loop();
  // instead call the internal path via start + stop after a tick is racy.
  // Use start() then immediately stop and wait for in-flight by polling status.
  await poller.start();
  // Wait for at least one cycle to complete.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const s = poller.status();
    if (s.cycles >= 1 && s.lastCyclePages > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  poller.stop();

  const status = poller.status();
  assert.ok(status.cycles >= 1, `expected >=1 cycle, got ${status.cycles}`);
  assert.equal(status.lastCyclePages, 6);
  assert.equal(status.lastCycleEmptyPages, 6);
  assert.ok(status.emptyPages >= 6);
  assert.ok(status.pagesScanned >= 6);
  assert.equal(sent.length, 0);

  // Restart should not reset cumulative counters (in-memory lifetime), but a
  // fresh createPoller would. Regression: counters stay finite and non-negative.
  assert.ok(status.emptyPages >= status.lastCycleEmptyPages);
  assert.ok(status.pagesScanned >= status.lastCyclePages);
  assert.ok(status.emptyPages <= status.pagesScanned);

  await rm(tmp, { recursive: true, force: true });
});

test("poller scan failure does not inflate empty-page counters", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mimir-poller-"));
  const cursorFile = path.join(tmp, "cursor.json");

  const server = {
    async getHealth() {
      return { status: "healthy", latestLedger: 100, oldestLedger: 1 };
    },
    async getEvents() {
      throw new Error("RPC unavailable");
    },
  };

  const poller = createPoller({
    config: {
      marketContractId: "C" + "A".repeat(55),
      squadContractId: "C" + "B".repeat(55),
      rpcUrl: "https://example.invalid",
      horizonUrl: "https://example.invalid",
      networkPassphrase: "Test SDF Network ; September 2015",
      botToken: "0:fake",
      chatId: "-1001",
      pollIntervalMs: 60_000,
      startLookbackLedgers: 10,
      cursorFile,
      maxNotificationsPerCycle: 20,
    },
    server,
    send: async () => {},
  });

  await poller.start();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const s = poller.status();
    // cycles increments at cycle start; wait until the cycle finishes failing.
    if (s.cycles >= 1 && s.consecutiveFailures >= 1 && s.lastError) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  poller.stop();

  const status = poller.status();
  assert.ok(status.cycles >= 1);
  assert.equal(status.emptyPages, 0);
  assert.equal(status.pagesScanned, 0);
  assert.equal(status.lastCycleEmptyPages, 0);
  assert.equal(status.lastCyclePages, 0);
  assert.ok(status.consecutiveFailures >= 1);
  assert.ok(status.lastError);

  await rm(tmp, { recursive: true, force: true });
});
