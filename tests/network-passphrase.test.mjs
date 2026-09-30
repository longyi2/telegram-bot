/**
 * Tests for RPC network passphrase verification.
 *
 * Covers positive and negative scenarios:
 * - Passphrase match: verification succeeds
 * - Passphrase mismatch: bounded error message (no actual passphrases leaked)
 * - Missing passphrase: malformed response handling
 * - RPC error: network failure handling
 * - Type validation: non-string passphrase handling
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NetworkPassphraseMismatchError,
  validateNetworkPassphrase,
} from "../dist/stellar/client.js";

/** Mock RPC server for testing. */
function makeMockRpc(network) {
  return {
    getNetwork: () => Promise.resolve(network),
  };
}

test("passphrase match: validation succeeds", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc({
    passphrase: "Test SDF Network ; September 2015",
    protocolVersion: "22.1.0",
  });

  // Should not throw
  await validateNetworkPassphrase(rpc, config);
});

test("passphrase mismatch: throws NetworkPassphraseMismatchError with problem='mismatch'", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc({
    passphrase: "Public Global Stellar Network ; September 2015",
    protocolVersion: "22.1.0",
  });

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    assert.equal(err.problem, "mismatch");
    // Error message should NOT contain the actual passphrases
    assert(!err.message.includes("Test SDF Network"));
    assert(!err.message.includes("Public Global Stellar"));
    // Should include character counts for diagnosis
    assert(err.message.includes("chars"));
  }
});

test("passphrase missing from response: throws with problem='malformed'", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc({
    protocolVersion: "22.1.0",
    // passphrase is missing
  });

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    assert.equal(err.problem, "malformed");
    assert(err.message.includes("string"));
  }
});

test("passphrase is not a string: throws with problem='malformed'", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc({
    passphrase: 12345, // Wrong type
    protocolVersion: "22.1.0",
  });

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    assert.equal(err.problem, "malformed");
    assert(err.message.includes("expected a string"));
  }
});

test("passphrase is null: throws with problem='malformed'", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc({
    passphrase: null,
    protocolVersion: "22.1.0",
  });

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    assert.equal(err.problem, "malformed");
  }
});

test("getNetwork() throws: throws with problem='missing'", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = {
    getNetwork: () => Promise.reject(new Error("RPC connection error")),
  };

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    assert.equal(err.problem, "missing");
    assert(err.message.includes("getNetwork failed"));
    // Error message is bounded (no unbounded remote payloads)
    assert(err.message.length < 200);
  }
});

test("case-sensitive comparison: 'test' != 'TEST'", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc({
    passphrase: "test sdf network ; september 2015",
    protocolVersion: "22.1.0",
  });

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    assert.equal(err.problem, "mismatch");
  }
});

test("whitespace difference: ' ' at end is significant", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc({
    passphrase: "Test SDF Network ; September 2015 ", // Extra space
    protocolVersion: "22.1.0",
  });

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    assert.equal(err.problem, "mismatch");
  }
});

test("empty string passphrase mismatch", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc({
    passphrase: "",
    protocolVersion: "22.1.0",
  });

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    assert.equal(err.problem, "mismatch");
    assert(err.message.includes("configured="));
    assert(err.message.includes("received="));
  }
});

test("configured empty string matches RPC empty string", async () => {
  const config = {
    networkPassphrase: "",
  };
  const rpc = makeMockRpc({
    passphrase: "",
    protocolVersion: "22.1.0",
  });

  // Should not throw
  await validateNetworkPassphrase(rpc, config);
});

test("getNetwork returns null: throws with problem='malformed'", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc(null);

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    assert.equal(err.problem, "malformed");
  }
});

test("getNetwork returns an empty object: throws with problem='malformed'", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc({});

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    assert.equal(err.problem, "malformed");
  }
});

test("error message is bounded: no unbounded remote payload", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const longError =
    "A".repeat(200) + " " + "B".repeat(200); // Very long error message
  const rpc = {
    getNetwork: () => Promise.reject(new Error(longError)),
  };

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert(err instanceof NetworkPassphraseMismatchError);
    // Error message should be capped (no more than ~100 chars of the remote error)
    const match = err.message.match(/"([^"]+)"/);
    if (match) {
      assert(match[1].length <= 101); // 100 chars + ellipsis
    }
  }
});

test("NetworkPassphraseMismatchError has name='NetworkPassphraseMismatchError'", async () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const rpc = makeMockRpc({
    passphrase: "Wrong",
    protocolVersion: "22.1.0",
  });

  try {
    await validateNetworkPassphrase(rpc, config);
    assert.fail("Expected NetworkPassphraseMismatchError");
  } catch (err) {
    assert.equal(err.name, "NetworkPassphraseMismatchError");
    assert(err instanceof Error);
  }
});
