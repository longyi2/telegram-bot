import assert from "node:assert/strict";
import test from "node:test";

import {
  paginatedGetEvents,
  readContractEvents,
  eventCursorLedger,
  EVENT_PAGE_LIMIT,
  EVENT_MAX_PAGES,
} from "../dist/stellar/events.js";

function makeCursor(ledger, index = 1) {
  const toid = BigInt(ledger) << 32n;
  return `${toid.toString()}-${index}`;
}

function makeRawEvent(ledger, contractId, name = "test_event") {
  return {
    type: "contract",
    ledger,
    ledgerClosedAt: "2023-01-01T00:00:00Z",
    contractId,
    id: makeCursor(ledger),
    pagingToken: makeCursor(ledger),
    topic: [], // Will decode as unknown due to missing scVal
    value: null,
    inSuccessfulContractCall: true,
    txHash: "0000",
  };
}

function createFakeServer(options = {}) {
  const { oldestLedger = 100, latestLedger = 200, events = [], failOn = null } = options;
  let getEventsCount = 0;

  return {
    async getHealth() {
      if (failOn === "health") throw new Error("RPC Health Failure");
      return { oldestLedger, latestLedger };
    },
    async getEvents(req) {
      if (failOn === "events") throw new Error("RPC Events Failure");
      getEventsCount++;

      let start = 0;
      if (req.cursor) {
        start = events.findIndex((e) => e.id === req.cursor);
        if (start === -1) {
          // unknown cursor, just return empty
          return { events: [], latestLedger, cursor: req.cursor };
        }
        start += 1;
      } else if (req.startLedger) {
        start = events.findIndex((e) => e.ledger >= req.startLedger);
        if (start === -1) start = events.length;
      }

      const chunk = events.slice(start, start + req.limit);
      const nextCursor = chunk.length > 0 ? chunk[chunk.length - 1].id : req.cursor || "";

      return {
        events: chunk,
        latestLedger,
        cursor: nextCursor,
      };
    },
    getEventsCount() {
      return getEventsCount;
    },
  };
}

test("paginatedGetEvents (positive): reads all events up to tip and stops", async () => {
  const allEvents = [
    makeRawEvent(110, "CA"),
    makeRawEvent(120, "CA"),
    makeRawEvent(130, "CA"),
    makeRawEvent(140, "CA"), // 4 events
  ];
  const server = createFakeServer({ events: allEvents });

  const result = await paginatedGetEvents(server, [], { startLedger: 100, limit: 2 });
  assert.equal(result.events.length, 4);
  assert.equal(result.cursor, allEvents[3].id);
  assert.equal(result.truncated, false);
  assert.equal(server.getEventsCount(), 3); // 2 full pages + 1 empty page to hit tip
});

test("paginatedGetEvents (boundary): stops reading if maxPages reached", async () => {
  const allEvents = Array.from({ length: 10 }, (_, i) => makeRawEvent(110 + i, "CA"));
  const server = createFakeServer({ events: allEvents });

  // Limit 2 per page, maxPages 3 -> should read 6 events and truncate
  const result = await paginatedGetEvents(server, [], { startLedger: 100, limit: 2, maxPages: 3 });
  assert.equal(result.events.length, 6);
  assert.equal(result.cursor, allEvents[5].id);
  assert.equal(result.truncated, true);
  assert.equal(server.getEventsCount(), 3);
});

test("paginatedGetEvents (negative): throws if getHealth fails", async () => {
  const server = createFakeServer({ failOn: "health" });
  await assert.rejects(paginatedGetEvents(server, []), /RPC Health Failure/);
});

test("paginatedGetEvents (negative): throws if getEvents fails", async () => {
  const server = createFakeServer({ failOn: "events" });
  await assert.rejects(paginatedGetEvents(server, []), /RPC Events Failure/);
});

test("paginatedGetEvents (restart): resumes from cursor", async () => {
  const allEvents = [
    makeRawEvent(110, "CA"),
    makeRawEvent(120, "CA"),
    makeRawEvent(130, "CA"),
  ];
  const server = createFakeServer({ events: allEvents });

  const result = await paginatedGetEvents(server, [], { cursor: allEvents[0].id, limit: 10 });
  assert.equal(result.events.length, 2); // 120 and 130
  assert.equal(result.events[0].id, allEvents[1].id);
  assert.equal(result.cursor, allEvents[2].id);
});

test("paginatedGetEvents (boundary): empty response retains cursor", async () => {
  const server = createFakeServer({ events: [], latestLedger: 100 });
  const result = await paginatedGetEvents(server, [], { cursor: "123-1", limit: 10 });
  assert.equal(result.events.length, 0);
  assert.equal(result.cursor, "123-1");
});

test("readContractEvents: parses events properly to UnknownPayload on mock", async () => {
  const server = createFakeServer({
    events: [makeRawEvent(150, "CA")],
  });
  const result = await readContractEvents(server, { source: "market", contractId: "CA" });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].payload.name, "unknown");
  assert.equal(result.lastEventLedger, 150);
});

test("eventCursorLedger (positive/negative): decodes valid cursor, null on invalid", () => {
  assert.equal(eventCursorLedger(makeCursor(42, 1)), 42);
  assert.equal(eventCursorLedger("invalid"), null);
  assert.equal(eventCursorLedger(""), null);
});
