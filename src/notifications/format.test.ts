import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDigest } from "./format.js";
import type { DecodedEvent } from "../stellar/decode.js";

describe("formatDigest", () => {
  it("returns null for an empty array", () => {
    assert.equal(formatDigest([]), null);
  });

  it("combines multiple events with a header", () => {
    const events = [
      {
        source: "market",
        contractId: "C123",
        id: "evt1",
        ledger: 100,
        payload: { name: "claim_created", claimId: "1", category: "Test", creator: "G123" }
      },
      {
        source: "squad",
        contractId: "C456",
        id: "evt2",
        ledger: 101,
        payload: { name: "market_created", marketId: "2", question: "Test?", captain: "G456", feeBps: 100, deadline: 1000 }
      }
    ] as unknown as DecodedEvent[];

    const result = formatDigest(events);
    assert.ok(result !== null, "Result should not be null");
    assert.ok(result.includes("*Mimir Digest*"), "Should contain digest header");
    assert.ok(result.includes("events in this cycle"), "Should contain count");
  });
});
