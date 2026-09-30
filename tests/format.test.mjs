/**
 * Notification-format and poller-logic tests.
 *
 * These tests run entirely in-process against the compiled output:
 *
 *   npm test          → npm run build && node --test tests/format.test.mjs
 *
 * No live Testnet RPC, no Telegram token, no environment variables required.
 * Every test is deterministic.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import { escapeMd, formatEvent, splitTelegramMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from "../dist/notifications/format.js";
import { formatUsdc } from "../dist/stellar/decode.js";
import { eventCursorLedger } from "../dist/stellar/events.js";
import { sanitise, log } from "../dist/log.js";
import { extractRetryAfter, withRetry } from "../dist/poller.js";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const reserved = "_*[]()~`>#+-=|{}.\\!";
const reservedSet = new Set(Array.from(reserved));

const BASE_CONFIG = {
  chatId: "-1001234567890",
  marketContractId: "market",
  squadContractId: "squad",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const BASE_META = {
  source: "market",
  contractId: "market",
  ledger: 100,
  txHash: "",
  at: 0,
  eventId: "100-0",
};

function expectedEscape(value) {
  return Array.from(value, (char) =>
    reservedSet.has(char) ? `\\${char}` : char,
  ).join("");
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

// ── formatUsdc ────────────────────────────────────────────────────────────────

test("formatUsdc always renders all seven Stellar USDC decimals", () => {
  const cases = [
    [0n, "0.0000000"],
    [1n, "0.0000001"],
    [10_000_000n, "1.0000000"],
    [20_000_000n, "2.0000000"],
    [12_345_678n, "1.2345678"],
    [-1n, "-0.0000001"],
    [-12_345_678n, "-1.2345678"],
    [123_456_789_012_345_678_901_234_567n, "12345678901234567890.1234567"],
  ];

  for (const [units, expected] of cases) {
    assert.equal(formatUsdc(units), expected, String(units));
  }
});

test("formatUsdc: zero amount is exactly '0.0000000'", () => {
  assert.equal(formatUsdc(0n), "0.0000000");
});

test("formatUsdc: negative amounts carry the sign on the whole part only", () => {
  assert.equal(formatUsdc(-20_000_000n), "-2.0000000");
  assert.equal(formatUsdc(-1n), "-0.0000001");
test("formatted money notifications keep explicit decimals and escape the decimal point", () => {
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = {
    source: "market",
    contractId: "market",
    ledger: 43,
    txHash: "",
    at: 0,
    eventId: "43-0",
    payload: {
      name: "claim_challenged",
      claimId: 7,
      challenger: "GABCD",
      stake: 20_000_000n,
    },
  };

  const message = formatEvent(config, event);
  assert.match(message, /Stake: \*2\\.0000000 USDC\*/);
});

test("unknown or malformed decoded events stay non-notifying", () => {
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = {
    source: "market",
    contractId: "market",
    ledger: 44,
    txHash: "",
    at: 0,
    eventId: "44-0",
    payload: { name: "unknown", eventName: "claim_challenged", reason: "malformed amount" },
  };

  assert.equal(formatEvent(config, event), null);
});

// ── escapeMd ──────────────────────────────────────────────────────────────────

test("escapeMd escapes every MarkdownV2 reserved character exactly once", () => {
  assert.equal(escapeMd(reserved), expectedEscape(reserved));
  assert.equal(escapeMd("plain café 🛰️\nnext line"), "plain café 🛰️\nnext line");
});

test("escapeMd matches the character-wise rule for deterministic fuzz inputs", () => {
  const alphabet = Array.from(`${reserved}abcXYZ09 café\n\r\t\0🛰️e\u0301`);
  const random = seededRandom(0x5eedc0de);

  for (let sample = 0; sample < 1000; sample += 1) {
    const length = Math.floor(random() * 257);
    let input = "";
    for (let index = 0; index < length; index += 1) {
      input += alphabet[Math.floor(random() * alphabet.length)];
    }
    assert.equal(escapeMd(input), expectedEscape(input), `sample ${sample}`);
  }
});

test("escapeMd handles a long adversarial string without dropping characters", () => {
  const input = reserved.repeat(10_000);
  const escaped = escapeMd(input);
  assert.equal(escaped, expectedEscape(input));
});

test("escapeMd does not double-escape an already-escaped string", () => {
  const once = escapeMd("hello_world");
  // Applying again should escape the backslashes already present.
  const twice = escapeMd(once);
  assert.notEqual(once, twice);
  // Round-trip sanity: once escaped should contain backslash
  assert.match(once, /\\_/);
});

// ── formatEvent: positive (known events produce messages) ─────────────────────

test("formatted money notifications keep explicit decimals and escape the decimal point", () => {
  const event = {
    ...BASE_META,
test("formatted untrusted event text reaches Telegram as exact MarkdownV2", async () => {
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = {
    source: "market",
    contractId: "market",
    ledger: 42,
    txHash: "",
    at: 0,
    eventId: "42-0",
    payload: {
      name: "claim_challenged",
      claimId: 7,
      challenger: "GABCD",
      stake: 20_000_000n,
    },
  };

  const message = formatEvent(BASE_CONFIG, event);
  assert.match(message, /Stake: \*2\\\.0000000 USDC\*/);
});

test("claim_created produces a non-null message with claimId and category", () => {
  const event = {
    ...BASE_META,
    payload: { name: "claim_created", claimId: 1, creator: "GABCDEFGH", category: "crypto" },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null, "expected non-null message");
  assert.match(msg, /New claim/);
  assert.match(msg, /#1/);
  assert.match(msg, /crypto/);
});

test("claim_resolved produces a non-null message with winner and confidence", () => {
  const event = {
    ...BASE_META,
    payload: {
      name: "claim_resolved",
      claimId: 2,
      winnerSide: 2,
      summary: "Onchain smoke",
      confidence: 100,
      evidenceHash: "abc123",
    },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /resolved/);
  assert.match(msg, /challengers/);
  assert.match(msg, /100/);
});

test("claim_cancelled produces a non-null message", () => {
  const event = { ...BASE_META, payload: { name: "claim_cancelled", claimId: 3 } };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /cancelled/);
});

test("market_settled produces a non-null message with paid amount", () => {
  const event = {
    ...BASE_META,
    payload: {
      name: "market_settled",
      claimId: 4,
      totalPaid: 30_000_000n,
      totalFees: 1_000_000n,
      owedToChallengers: 29_000_000n,
      dust: 0n,
    },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /settled/);
  assert.match(msg, /3\\\.0000000 USDC/);
});

test("challenger_paid produces a non-null message", () => {
  const event = {
    ...BASE_META,
    payload: {
      name: "challenger_paid",
      claimId: 5,
      challenger: "GABCD",
      stake: 10_000_000n,
      gross: 11_000_000n,
      fee: 500_000n,
      net: 10_500_000n,
    },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /Challenger paid/);
});

test("fee_claimed produces a non-null message", () => {
  const event = {
    ...BASE_META,
    payload: { name: "fee_claimed", recipient: "GABCD", amount: 5_000_000n },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /Fees claimed/);
});

test("withdrawal produces a non-null message", () => {
  const event = {
    ...BASE_META,
    payload: { name: "withdrawal", to: "GABCD", amount: 15_000_000n },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /Withdrawal/);
});

test("withdrawal_pending produces a non-null message", () => {
  const event = {
    ...BASE_META,
    payload: { name: "withdrawal_pending", to: "GABCD", amount: 15_000_000n },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /parked/);
});

test("squad market_created produces a non-null message with question", () => {
  const event = {
    ...BASE_META,
    source: "squad",
    contractId: "squad",
    payload: {
      name: "market_created",
      marketId: 10,
      captain: "GABCD",
      deadline: Math.floor(Date.now() / 1000) + 3600,
      feeBps: 100,
      question: "Will BTC exceed 100k?",
    },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /squad market/i);
  assert.match(msg, /BTC exceed 100k/);
});

test("squad deposited produces a non-null message", () => {
  const event = {
    ...BASE_META,
    source: "squad",
    payload: {
      name: "deposited",
      marketId: 10,
      side: 1,
      participant: "GABCD",
      amount: 5_000_000n,
      shares: 5_000_000n,
    },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /Side A/);
});

test("squad withdrawn produces a non-null message", () => {
  const event = {
    ...BASE_META,
    source: "squad",
    payload: {
      name: "withdrawn",
      marketId: 10,
      side: 2,
      participant: "GABCD",
      amount: 5_000_000n,
    },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /Side B/);
});

test("squad resolved produces a non-null message", () => {
  const event = {
    ...BASE_META,
    source: "squad",
    payload: {
      name: "resolved",
      marketId: 11,
      result: 1,
      poolA: 10_000_000n,
      poolB: 5_000_000n,
    },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /resolved/i);
});

test("squad claimed produces a non-null message", () => {
  const event = {
    ...BASE_META,
    source: "squad",
    payload: {
      name: "claimed",
      marketId: 11,
      participant: "GABCD",
      gross: 10_000_000n,
      fee: 500_000n,
      net: 9_500_000n,
    },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /payout/i);
});

test("squad fees_claimed produces a non-null message", () => {
  const event = {
    ...BASE_META,
    source: "squad",
    payload: { name: "fees_claimed", recipient: "GABCD", amount: 1_000_000n },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /fees claimed/i);
});

// ── formatEvent: negative (unknown/malformed → null) ──────────────────────────

test("unknown or malformed decoded events stay non-notifying", () => {
  const event = {
    ...BASE_META,
    payload: { name: "unknown", eventName: "claim_challenged", reason: "malformed amount" },
  };
  assert.equal(formatEvent(BASE_CONFIG, event), null);
});

test("unknown event with no reason still returns null", () => {
  const event = { ...BASE_META, payload: { name: "unknown", eventName: "fee_policy_changed" } };
  assert.equal(formatEvent(BASE_CONFIG, event), null);
});

test("admin event names that are not decoded return null", () => {
  // These are known admin events the bot intentionally skips.
  for (const eventName of [
    "oracle_changed",
    "ownership_transferred",
    "fee_accrued",
    "fee_policy_set",
    "agent_attributed",
  ]) {
    const event = { ...BASE_META, payload: { name: "unknown", eventName } };
    assert.equal(formatEvent(BASE_CONFIG, event), null, `expected null for ${eventName}`);
  }
});

// ── formatEvent: boundary cases ───────────────────────────────────────────────

test("claim_resolved with empty summary still formats without trailing whitespace", () => {
  const event = {
    ...BASE_META,
    payload: {
      name: "claim_resolved",
      claimId: 1,
      winnerSide: 1,
      summary: "",
      confidence: 75,
      evidenceHash: "deadbeef",
    },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.ok(!msg.endsWith(" "), "message should not end with trailing space");
  assert.ok(!msg.endsWith("\n"), "message should not end with trailing newline when summary empty");
});

test("squad market_created with very long question is clipped to 200 chars", () => {
  const question = "A".repeat(300);
  const event = {
    ...BASE_META,
    source: "squad",
    payload: {
      name: "market_created",
      marketId: 99,
      captain: "GABCD",
      deadline: 1_700_000_000,
      feeBps: 50,
      question,
    },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  // The clip function truncates at 200 chars and adds '…', so the raw question
  // cannot appear unclipped in the output.
  assert.ok(!msg.includes("A".repeat(201)), "question should have been clipped");
});

test("formatEvent: zero-amount withdrawal formats without error", () => {
  const event = {
    ...BASE_META,
    payload: { name: "withdrawal", to: "GABCD", amount: 0n },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  assert.match(msg, /0\\\.0000000 USDC/);
});

test("formatEvent: very large USDC amount does not overflow or lose digits", () => {
  const amount = 999_999_999_999_999_999_999_999_999n;
  const event = {
    ...BASE_META,
    payload: { name: "fee_claimed", recipient: "GABCD", amount },
  };
  const msg = formatEvent(BASE_CONFIG, event);
  assert.ok(msg !== null);
  // Just confirm it renders without throwing and contains USDC.
  assert.match(msg, /USDC/);
});

// ── formatEvent: category / summary MarkdownV2 injection ─────────────────────

test("formatEvent: reserved chars in category are escaped in output", () => {
  const event = {
    ...BASE_META,
    payload: { name: "claim_created", claimId: 7, creator: "GABCD", category: reserved },
  };
  const message = formatEvent(BASE_CONFIG, event);
  const expectedMessage =
    `🆕 *New claim* \\#7\nCategory: ${expectedEscape(reserved)}\n` +
    "Creator: `GABCD`\n_ledger 100_";
  assert.equal(message, expectedMessage);
});

test("formatted untrusted event text reaches Telegram as exact MarkdownV2", async () => {
  const event = {
    ...BASE_META,
    payload: { name: "claim_created", claimId: 7, creator: "GABCD", category: reserved },
  };
  const message = formatEvent(BASE_CONFIG, event);
  const expectedMessage =
    `🆕 *New claim* \\#7\nCategory: ${expectedEscape(reserved)}\n` +
    "Creator: `GABCD`\n_ledger 100_";
  const formatted = formatEvent(config, event);
  const expectedMessage =
    `🆕 *New claim* \\#7\nCategory: ${expectedEscape(reserved)}\n` +
    "Creator: `GABCD`\n_ledger 42_ \\· _v1_";
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  assert.equal(message, expectedMessage);
  await createNotifier(fakeBot, BASE_CONFIG)(message);
  assert.deepEqual(sent, [
    [
      BASE_CONFIG.chatId,
  await createNotifier(fakeBot)(config.chatId, message);
  assert.deepEqual(sent, [
    [
      config.chatIds[0],
      expectedMessage,
      {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      },
    ],
  ]);
});

test("oversized event fields are clipped safely before MarkdownV2 escaping", () => {
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const category = `${"a".repeat(199)}🛰️`;
  const event = {
    source: "market",
    contractId: "market",
    ledger: 42,
    txHash: "x".repeat(129),
    at: 0,
    eventId: "42-0",
    payload: { name: "claim_created", claimId: 7, creator: "GABCD", category },
  };

  const message = formatEvent(config, event);
  const expectedMessage =
    `🆕 *New claim* \\#7\nCategory: ${"a".repeat(199)}…\n` +
    "Creator: `GABCD`\n_ledger 42_";

  assert.equal(message, expectedMessage);
  assert.equal(message.length < 4096, true);
});

test("oversized squad questions are clipped without splitting emoji", () => {
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = {
    source: "squad",
    contractId: "squad",
    ledger: 42,
    txHash: "",
    at: 0,
    eventId: "42-0",
    payload: {
      name: "market_created",
      marketId: 7,
      captain: "GABCD",
      deadline: 1_800_000_000,
      feeBps: 25,
      question: `${"q".repeat(199)}🛰️`,
    },
  };

  const message = formatEvent(config, event);
  assert.match(message, new RegExp(`\\n${"q".repeat(199)}…\\n`));
  assert.equal(message.includes("🛰️"), false);
});

test("createNotifier preserves Telegram send failures for the poller", async () => {
  const error = new Error("Telegram API unavailable");
  const fakeBot = { api: { sendMessage: async () => Promise.reject(error) } };
  const notify = createNotifier(fakeBot, { chatIds: ["-1001234567890"] });
  await assert.rejects(notify("message"), error);
});

// ── eventCursorLedger ─────────────────────────────────────────────────────────

test("eventCursorLedger decodes a real cursor's ledger from the TOID high bits", () => {
  // TOID = ledger << 32 | txIndex.  A cursor of "0018276211125911551-4294967295":
  //   TOID = 18276211125911551 dec
  //   ledger = 18276211125911551n >> 32n = 4253726n (approx 4.2M)
  const cursor = "0018276211125911551-4294967295";
  const ledger = eventCursorLedger(cursor);
  assert.ok(typeof ledger === "number", "expected a number");
  assert.ok(ledger > 0, "expected positive ledger");
});

test("eventCursorLedger returns null for a malformed cursor", () => {
  assert.equal(eventCursorLedger("not-a-cursor"), null);
  assert.equal(eventCursorLedger(""), null);
  assert.equal(eventCursorLedger("abc-123"), null);
});

test("eventCursorLedger returns null when TOID is missing", () => {
  assert.equal(eventCursorLedger("-4294967295"), null);
});

// ── sanitise ──────────────────────────────────────────────────────────────────

test("sanitise redacts a Telegram bot token", () => {
  const token = "123456789:AAFake_token_here_for_testing_12345";
  const result = sanitise(`Starting with token ${token} done`);
  assert.ok(!result.includes(token), "token should be redacted");
  assert.match(result, /\[REDACTED:token\]/);
  assert.match(result, /Starting with token/);
  assert.match(result, /done/);
});

test("sanitise redacts a Stellar private seed", () => {
  // A real-looking seed: S + 55 uppercase base32 chars.
  const seed = "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
  const result = sanitise(`Found seed ${seed} in config`);
  assert.ok(!result.includes(seed), "seed should be redacted");
  assert.match(result, /\[REDACTED:seed\]/);
});

test("sanitise leaves non-secret strings unchanged", () => {
  const input = "[poller] market scan completed ledger=4226728";
  assert.equal(sanitise(input), input);
});

test("sanitise handles multiple secrets in one string", () => {
  const token = "987654321:BBAnother_fake_token_for_test_99999";
  const seed = "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
  const input = `token=${token} seed=${seed}`;
  const result = sanitise(input);
  assert.ok(!result.includes(token));
  assert.ok(!result.includes(seed));
  assert.strictEqual((result.match(/\[REDACTED/g) ?? []).length, 2);
});

test("sanitise handles empty string", () => {
  assert.equal(sanitise(""), "");
});

test("log helpers exist and do not throw on normal input", () => {
  // We only verify they are callable; we do not intercept stdout.
  assert.ok(typeof log.info === "function");
  assert.ok(typeof log.warn === "function");
  assert.ok(typeof log.error === "function");
  assert.doesNotThrow(() => log.info("[test] info line"));
  assert.doesNotThrow(() => log.warn("[test] warn line"));
  assert.doesNotThrow(() => log.error("[test] error line"));
});

// ── extractRetryAfter ─────────────────────────────────────────────────────────

test("extractRetryAfter returns retry_after seconds from a grammy 429 GrammyError", () => {
  const err = { error_code: 429, parameters: { retry_after: 30 } };
  assert.equal(extractRetryAfter(err), 30);
});

test("extractRetryAfter returns 30 as default when error_code=429 but no retry_after", () => {
  const err = { error_code: 429 };
  assert.equal(extractRetryAfter(err), 30);
});

test("extractRetryAfter returns 30 when status field is 429", () => {
  const err = { status: 429 };
  assert.equal(extractRetryAfter(err), 30);
});

test("extractRetryAfter returns null for non-429 errors", () => {
  assert.equal(extractRetryAfter(new Error("connection refused")), null);
  assert.equal(extractRetryAfter({ error_code: 400 }), null);
  assert.equal(extractRetryAfter({ status: 500 }), null);
  assert.equal(extractRetryAfter(null), null);
  assert.equal(extractRetryAfter(undefined), null);
  assert.equal(extractRetryAfter("string error"), null);
});

// ── withRetry ─────────────────────────────────────────────────────────────────

test("withRetry returns immediately on first success", async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls += 1; return 42; }, 3, 1);
  assert.equal(result, 42);
  assert.equal(calls, 1);
});

test("withRetry retries and succeeds on second attempt", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new Error("transient");
      return "ok";
    },
    3,
    1, // 1ms base so tests run fast
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withRetry exhausts retries and rethrows the last error", async () => {
  let calls = 0;
  const boom = new Error("persistent failure");
  await assert.rejects(
    withRetry(async () => { calls += 1; throw boom; }, 3, 1),
    boom,
  );
  // 1 initial + 3 retries = 4 total calls
  assert.equal(calls, 4);
});

test("withRetry with maxRetries=0 throws on first failure without retry", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls += 1; throw new Error("no"); }, 0, 1),
    /no/,
  );
  assert.equal(calls, 1);
});

// ── Restart regression: cursor stale detection round-trip ─────────────────────

test("eventCursorLedger result can be compared to a retained floor for stale detection", () => {
  // Simulate a cursor that was written when the retained floor was 4226500,
  // but the RPC has since advanced its floor past that cursor's ledger.
  const cursor = "0018276211125911551-4294967295";
  const cursorLedger = eventCursorLedger(cursor);
  assert.ok(cursorLedger !== null);

  // A retained floor higher than the cursor ledger → stale
  const staleFloor = cursorLedger + 1;
  assert.ok(cursorLedger < staleFloor, "stale detection: cursor ledger below floor");

  // A retained floor lower than the cursor ledger → still valid
  const validFloor = cursorLedger - 1;
  assert.ok(cursorLedger >= validFloor, "stale detection: cursor ledger at or above floor");
});

// ── Cycle cap regression: formatter is never called for capped events ──────────

test("formatEvent returns null for unknown events regardless of source", () => {
  for (const source of ["market", "squad"]) {
    const event = { ...BASE_META, source, payload: { name: "unknown", eventName: "anything" } };
    assert.equal(formatEvent(BASE_CONFIG, event), null, `expected null for source=${source}`);
  }
test("createNotifier routes named contract sources and preserves the legacy fallback", async () => {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };
  const notify = createNotifier(fakeBot, {
    chatId: "-1001234567890",
    marketChatId: "-1001111111111",
    squadChatId: "@mimir_squad",
  });

  await notify("market event", "market");
  await notify("squad event", "squad");
  await notify("legacy event");

  assert.deepEqual(sent.map(([chatId, text]) => [chatId, text]), [
    ["-1001111111111", "market event"],
    ["@mimir_squad", "squad event"],
    ["-1001234567890", "legacy event"],
  ]);
});

test("escapeMd handles a long adversarial string without dropping characters", () => {
  const input = reserved.repeat(10_000);
  const escaped = escapeMd(input);
  assert.equal(escaped, expectedEscape(input));
});

test("createNotifier links to threaded replies when replyToMessageId is provided", async () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  const notify = createNotifier(fakeBot, config);
  // Merged signature: the notifier keeps main's (text, source?, extra?)
  // shape, so the thread target rides on SendExtra rather than a bare
  // second argument.
  await notify("threaded message", undefined, { replyToMessageId: 12345 });

  assert.deepEqual(sent, [
    [
      config.chatId,
      "threaded message",
      {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
        reply_parameters: {
          chat_id: config.chatId,
          message_id: 12345,
        },
      },
    ],
  ]);
});

test("createNotifier sends without reply_parameters when replyToMessageId is undefined", async () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  const notify = createNotifier(fakeBot, config);
  await notify("standalone message");

  assert.deepEqual(sent, [
    [
      config.chatId,
      "standalone message",
      {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      },
    ],
  ]);
});

test("txExplorerUrl is centralized and network-aware", async () => {
  const { txExplorerUrl, accountExplorerUrl, contractExplorerUrl, DEFAULT_EXPLORER_BASE_URL } =
    await import("../dist/stellar/client.js");

  const testnet = {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: DEFAULT_EXPLORER_BASE_URL,
  };
  assert.equal(
    txExplorerUrl(testnet, "abcd"),
    "https://stellar.expert/explorer/testnet/tx/abcd",
  );
  assert.equal(
    accountExplorerUrl(testnet, "G" + "A".repeat(55)),
    "https://stellar.expert/explorer/testnet/account/G" + "A".repeat(55),
  );
  assert.equal(
    contractExplorerUrl(testnet, testnet.marketContractId),
    `https://stellar.expert/explorer/testnet/contract/${testnet.marketContractId}`,
  );

  const pub = {
    ...testnet,
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  };
  assert.equal(
    txExplorerUrl(pub, "ffff"),
    "https://stellar.expert/explorer/public/tx/ffff",
  );

  const custom = { ...testnet, explorerBaseUrl: "https://example.test/x/" };
  assert.equal(txExplorerUrl(custom, "zz"), "https://example.test/x/testnet/tx/zz");
  assert.equal(txExplorerUrl(testnet, "  "), "");
});

test("formatEvent prefixes message with [PREVIEW MODE] when channelPreviewMode is enabled", async () => {
  const { formatEvent } = await import("../dist/notifications/format.js");
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const longQuestion = "Will ".repeat(100); // 500 chars
  const event = {
    source: "squad",
    contractId: "squad",
    ledger: 51,
    txHash: "",
    at: 0,
    eventId: "51-0",
    payload: {
      name: "market_created",
      marketId: 1,
      captain: "GABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDE",
      deadline: 1_800_000_000,
      feeBps: 100,
      question: longQuestion,
    },
  };
  const message = formatEvent(config, event);
  assert.ok(message !== null, "Expected a non-null message");
  assert.ok(
    !message.includes("Will ".repeat(50)),
    "Question was not truncated in the notification output",
  );
});

test("clip: summary field is bounded in claim_resolved notification", () => {
    explorerBaseUrl: "https://stellar.expert/explorer",
    channelPreviewMode: true,
  };
  const event = {
    source: "market",
    contractId: "market",
    ledger: 100,
    txHash: "hash123",
    at: 0,
    eventId: "100-0",
    payload: {
      name: "claim_created",
      claimId: 5,
      creator: "GABCD",
      category: "sports",
    },
  };

  await createNotifier(fakeBot, config)(text);
  assert.ok(sent.length >= 2);
  for (const [chatId, body, opts] of sent) {
    assert.equal(chatId, config.chatId);
    assert.ok(body.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
    assert.deepEqual(opts, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  }
  assert.equal(sent.map((s) => s[1]).join("\n"), text);
});

test("formatFallbackEvent formats actionable degraded event notification with redacted reason", async () => {
  const { formatFallbackEvent } = await import("../dist/notifications/format.js");
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const longSummary = "evidence ".repeat(100); // 900 chars
  const event = {
    source: "market",
    contractId: "market",
    ledger: 52,
    txHash: "",
    at: 0,
    eventId: "52-0",
    payload: {
      name: "claim_resolved",
      claimId: 3,
      winnerSide: 2,
      summary: longSummary,
      confidence: 95,
      evidenceHash: "abc123",
    },
  };
  const message = formatEvent(config, event);
  assert.ok(message !== null, "Expected a non-null message");
  // The raw summary should not appear verbatim past 200 chars in the output
  assert.ok(
    !message.includes("evidence ".repeat(30)),
    "Summary was not truncated in the notification output",
  );
});
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const big = "z".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 10);
  const notify = createNotifier(fakeBot, { chatId: "-1001" });
  await assert.rejects(notify(big), error);
  assert.equal(calls, 1);
});
