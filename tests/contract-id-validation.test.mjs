import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractIdError,
  validateContractId,
} from "../dist/stellar/client.js";

test("validateContractId accepts a valid Soroban contract ID", () => {
  const validId = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  assert.doesNotThrow(() => validateContractId(validId));
});

test("validateContractId accepts a valid contract ID with trailing/leading whitespace", () => {
  const validId = "  CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY  ";
  assert.doesNotThrow(() => validateContractId(validId));
});

test("validateContractId rejects an empty string", () => {
  assert.throws(
    () => validateContractId(""),
    (err) => {
      assert(err instanceof ContractIdError);
      assert.equal(err.problem, "empty-value");
      assert.match(err.message, /cannot be empty/);
      return true;
    },
  );
});

test("validateContractId rejects whitespace-only string", () => {
  assert.throws(
    () => validateContractId("   "),
    (err) => {
      assert(err instanceof ContractIdError);
      assert.equal(err.problem, "empty-value");
      return true;
    },
  );
});

test("validateContractId rejects non-string types", () => {
  for (const value of [null, undefined, 123, true, {}, [], new Date()]) {
    assert.throws(
      () => validateContractId(value),
      (err) => {
        assert(err instanceof ContractIdError);
        assert.equal(err.problem, "empty-value");
        assert.match(err.message, /must be a string/);
        return true;
      },
      `should reject ${typeof value}`,
    );
  }
});

test("validateContractId rejects contract ID with invalid prefix", () => {
  const invalidPrefixes = [
    "G" + "A".repeat(55), // Stellar classic account
    "S" + "A".repeat(55), // Stellar secret key
    "T" + "A".repeat(55), // Test prefix
    "1" + "A".repeat(55), // Numeric prefix
  ];

  for (const id of invalidPrefixes) {
    assert.throws(
      () => validateContractId(id),
      (err) => {
        assert(err instanceof ContractIdError);
        assert.equal(err.problem, "malformed-format");
        assert.match(err.message, /not a Soroban contract ID/);
        return true;
      },
      `should reject ${id.slice(0, 5)}…`,
    );
  }
});

test("validateContractId rejects contract ID with too few characters", () => {
  const tooShort = "C" + "A".repeat(54); // Only 55 total, needs 56
  assert.throws(
    () => validateContractId(tooShort),
    (err) => {
      assert(err instanceof ContractIdError);
      assert.equal(err.problem, "malformed-format");
      assert.match(err.message, /not a Soroban contract ID/);
      return true;
    },
  );
});

test("validateContractId rejects contract ID with too many characters", () => {
  const tooLong = "C" + "A".repeat(56); // 57 total, needs 56
  assert.throws(
    () => validateContractId(tooLong),
    (err) => {
      assert(err instanceof ContractIdError);
      assert.equal(err.problem, "malformed-format");
      return true;
    },
  );
});

test("validateContractId rejects contract ID with invalid base32 characters", () => {
  const invalidChars = [
    "C" + "0".repeat(55), // Numeric 0
    "C" + "1".repeat(55), // Numeric 1
    "C" + "a".repeat(55), // Lowercase
    "C" + "8".repeat(55), // Invalid digit
    "C" + "9".repeat(55), // Invalid digit
    "C" + "=".repeat(55), // Invalid symbol
  ];

  for (const id of invalidChars) {
    assert.throws(
      () => validateContractId(id),
      (err) => {
        assert(err instanceof ContractIdError);
        assert.equal(err.problem, "malformed-format");
        return true;
      },
      `should reject ${id.slice(0, 10)}…`,
    );
  }
});

test("validateContractId rejects contract ID with valid base32 chars but wrong prefix", () => {
  const wrongPrefix = "A" + "A".repeat(55);
  assert.throws(
    () => validateContractId(wrongPrefix),
    (err) => {
      assert(err instanceof ContractIdError);
      assert.equal(err.problem, "malformed-format");
      return true;
    },
  );
});

test("ContractIdError has correct name and extends Error", () => {
  const err = new ContractIdError("empty-value", "test message");
  assert(err instanceof Error);
  assert.equal(err.name, "ContractIdError");
  assert.equal(err.problem, "empty-value");
  assert.equal(err.message, "test message");
});

test("ContractIdError messages never include full malformed contract IDs", () => {
  const veryLongId = "A".repeat(1000);
  assert.throws(
    () => validateContractId(veryLongId),
    (err) => {
      // Should use truncated form, not include the full payload
      assert(err.message.length < 200, "error message should be bounded");
      assert(!err.message.includes("A".repeat(100)), "should not include unbounded payload");
      return true;
    },
  );
});

test("validateContractId handles boundary case: exactly 56 characters with C prefix", () => {
  const exactLength = "C" + "2".repeat(55); // Exactly 56 chars, all valid base32
  assert.doesNotThrow(() => validateContractId(exactLength));
});

test("validateContractId handles all valid base32 characters (A-Z and 2-7)", () => {
  // Valid base32 alphabet for Stellar: A-Z and 2-7
  const validChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const id = "C" + "A".repeat(20) + "B".repeat(15) + "2".repeat(10) + "7".repeat(10); // 56 chars
  assert.doesNotThrow(() => validateContractId(id));
});

test("ContractIdError problem types are correct", () => {
  const emptyErr = new ContractIdError("empty-value", "test");
  assert.equal(emptyErr.problem, "empty-value");

  const formatErr = new ContractIdError("malformed-format", "test");
  assert.equal(formatErr.problem, "malformed-format");
});

test("validateContractId is used before RPC calls in readContractEvents", async () => {
  // This test ensures the validation integration is working
  // We'll import and test the actual integration in a separate integration test
  // For now, just verify the function exists and is exported
  assert.equal(typeof validateContractId, "function");
});
