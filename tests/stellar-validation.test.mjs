/**
 * Contract ID validation tests.
 *
 * Tests the runtime validateContractId function in stellar/client.ts
 * which is called at scan time to catch misconfigured contract IDs early.
 */

import assert from "node:assert/strict";
import test from "node:test";

test(
  "validateContractId accepts valid Soroban contract strkeys",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    const validIds = [
      "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI", // market
      "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY", // squad
      "C" + "A".repeat(55), // all A's
      "C" + "2".repeat(55), // all 2's (minimum base32)
      "C" + "7".repeat(55), // all 7's (maximum base32)
    ];

    for (const id of validIds) {
      assert.doesNotThrow(() => validateContractId(id));
    }
  }
);

test(
  "validateContractId rejects empty strings",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    assert.throws(
      () => validateContractId(""),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("empty"));
        return true;
      }
    );
  }
);

test(
  "validateContractId rejects whitespace-only strings",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    assert.throws(
      () => validateContractId("   "),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("empty"));
        return true;
      }
    );
  }
);

test(
  "validateContractId rejects strings with wrong prefix",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    const invalidIds = [
      "GDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI", // starts with G (account)
      "BDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI", // starts with B
      "1DV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI", // starts with 1
    ];

    for (const id of invalidIds) {
      assert.throws(
        () => validateContractId(id),
        (err) => {
          assert(err instanceof Error);
          assert(err.message.includes("valid Soroban contract ID"));
          return true;
        }
      );
    }
  }
);

test(
  "validateContractId rejects strings that are too short",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    const tooShort = [
      "C", // just the prefix
      "CD", // prefix + 1 char
      "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPK", // 55 chars total (need 56)
    ];

    for (const id of tooShort) {
      assert.throws(
        () => validateContractId(id),
        (err) => {
          assert(err instanceof Error);
          assert(err.message.includes("valid Soroban contract ID"));
          return true;
        }
      );
    }
  }
);

test(
  "validateContractId rejects strings that are too long",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    const tooLong = "C" + "A".repeat(56); // 57 chars total

    assert.throws(
      () => validateContractId(tooLong),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("valid Soroban contract ID"));
        return true;
      }
    );
  }
);

test(
  "validateContractId rejects strings with lowercase letters",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    const lowercase = [
      "CDV6jxijcalsxqelcs6yuewjwg5dfxqk5pj5i7mwi6kvmqjbc5dlpkzi",
      "C" + "a".repeat(55),
      "C" + "z".repeat(55),
    ];

    for (const id of lowercase) {
      assert.throws(
        () => validateContractId(id),
        (err) => {
          assert(err instanceof Error);
          assert(err.message.includes("valid Soroban contract ID"));
          return true;
        }
      );
    }
  }
);

test(
  "validateContractId rejects strings with invalid base32 characters",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    const invalidChars = [
      "C" + "0".repeat(55), // 0 is not in base32 alphabet
      "C" + "1".repeat(55), // 1 is not in base32 alphabet
      "C" + "8".repeat(55), // 8 is not in base32 alphabet (max is 7)
      "C" + "9".repeat(55), // 9 is not in base32 alphabet
      "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLP-ZI", // - is invalid
      "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLP@ZI", // @ is invalid
    ];

    for (const id of invalidChars) {
      assert.throws(
        () => validateContractId(id),
        (err) => {
          assert(err instanceof Error);
          assert(err.message.includes("valid Soroban contract ID"));
          return true;
        }
      );
    }
  }
);

test(
  "validateContractId uses custom field names in error messages",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    assert.throws(
      () => validateContractId("invalid", "market contract ID"),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("market contract ID"));
        return true;
      }
    );
  }
);

test(
  "validateContractId trims whitespace before validation",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    const withWhitespace = [
      "  CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI  ",
      "  CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI  ",
    ];

    for (const id of withWhitespace) {
      assert.doesNotThrow(() => validateContractId(id));
    }
  }
);

test(
  "validateContractId returns true on success",
  async () => {
    const { validateContractId } = await import("../dist/stellar/client.js");

    const result = validateContractId("CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI");
    assert.equal(result, true);
  }
);

// ── Integration tests: paginatedGetEvents and readContractEvents ───────────

test(
  "readContractEvents validates contract ID before calling RPC",
  async () => {
    // This test verifies that the validation happens and surfaces errors properly.
    // We use a fake server that would fail if actually called, but the validation
    // error comes first.
    const { readContractEvents } = await import("../dist/stellar/events.js");

    const fakeServer = {
      getHealth: async () => ({
        status: "ok",
        latestLedger: 1000,
        oldestLedger: 900,
      }),
      getEvents: async () => {
        throw new Error("getEvents should not have been called!");
      },
    };

    await assert.rejects(
      () =>
        readContractEvents(
          fakeServer,
          { source: "market", contractId: "invalid" },
          {}
        ),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("market contract ID"));
        // Make sure we didn't call getEvents
        assert(!err.message.includes("getEvents should not have been called"));
        return true;
      }
    );
  }
);

test(
  "readContractEvents passes validation for well-formed contract IDs",
  async () => {
    // This test verifies that a well-formed ID passes validation.
    // We use a fake server to avoid real RPC calls.
    const { readContractEvents } = await import("../dist/stellar/events.js");

    let getEventsCalled = false;
    const fakeServer = {
      getHealth: async () => ({
        status: "ok",
        latestLedger: 1000,
        oldestLedger: 900,
      }),
      getEvents: async () => {
        getEventsCalled = true;
        return {
          events: [],
          cursor: null,
          latestLedger: 1000,
        };
      },
    };

    // This should not throw during validation
    const result = await readContractEvents(
      fakeServer,
      { source: "market", contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI" },
      {}
    );

    // Verify getEvents was called (validation passed)
    assert(getEventsCalled);
    assert.equal(result.events.length, 0);
    assert.equal(result.contractId, "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI");
  }
);
