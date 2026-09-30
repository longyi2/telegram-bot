import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import { previewMessage } from "../dist/notifications/format.js";

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    lockFile: "/tmp/unused-lock.json",
    statusFile: "/tmp/unused-status.json",
    maxNotificationsPerCycle: 20,
    csvOutputFile: "/tmp/unused-scanner.csv",
    featureFlags: { enabled: true, market: true, squad: true },
    auditFile: "/tmp/unused-audit.jsonl",
    dedupWindow: 256,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    startupHealthDeadlineMs: 30_000,
    startupHealthRetryMs: 1_000,
    shutdownTimeoutMs: 10_000,
    telegramSendTimeoutMs: 10_000,
    channelPreviewMode: false,
    linkPreviewMarket: false,
    linkPreviewSquad: false,
    ...overrides,
  };
}

test("createNotifier: market notifications with LINK_PREVIEW_MARKET disabled (default)", async () => {
  const sent = [];
  const mockBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
      },
    },
  };

  const notifier = createNotifier(mockBot, baseConfig({ linkPreviewMarket: false }));
  await notifier("test message", "market");

  assert.equal(sent.length, 1);
  const [chatId, text, options] = sent[0];
  assert.equal(chatId, "-1001234567890");
  assert.equal(text, "test message");
  assert.deepEqual(options, {
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
  });
});

test("createNotifier: market notifications with LINK_PREVIEW_MARKET enabled", async () => {
  const sent = [];
  const mockBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
      },
    },
  };

  const notifier = createNotifier(mockBot, baseConfig({ linkPreviewMarket: true }));
  await notifier("test message with http://example.com", "market");

  assert.equal(sent.length, 1);
  const [chatId, text, options] = sent[0];
  assert.equal(chatId, "-1001234567890");
  assert.deepEqual(options, {
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: false },
  });
});

test("createNotifier: squad notifications with LINK_PREVIEW_SQUAD disabled (default)", async () => {
  const sent = [];
  const mockBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
      },
    },
  };

  const notifier = createNotifier(mockBot, baseConfig({ linkPreviewSquad: false }));
  await notifier("test message", "squad");

  assert.equal(sent.length, 1);
  const [chatId, text, options] = sent[0];
  assert.equal(chatId, "-1001234567890");
  assert.deepEqual(options, {
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
  });
});

test("createNotifier: squad notifications with LINK_PREVIEW_SQUAD enabled", async () => {
  const sent = [];
  const mockBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
      },
    },
  };

  const notifier = createNotifier(mockBot, baseConfig({ linkPreviewSquad: true }));
  await notifier("test message with http://example.com", "squad");

  assert.equal(sent.length, 1);
  const [chatId, text, options] = sent[0];
  assert.equal(chatId, "-1001234567890");
  assert.deepEqual(options, {
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: false },
  });
});

test("createNotifier: commands (no source) always have link previews disabled", async () => {
  const sent = [];
  const mockBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
      },
    },
  };

  // Even when market and squad are enabled, commands should have previews disabled
  const notifier = createNotifier(
    mockBot,
    baseConfig({ linkPreviewMarket: true, linkPreviewSquad: true })
  );
  await notifier("command response");

  assert.equal(sent.length, 1);
  const [, , options] = sent[0];
  assert.deepEqual(options, {
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
  });
});

test("createNotifier: routes to market chat when market source is specified", async () => {
  const sent = [];
  const mockBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
      },
    },
  };

  const config = baseConfig({
    chatId: "-1001111111111",
    marketChatId: "-1002222222222",
    linkPreviewMarket: true,
  });
  const notifier = createNotifier(mockBot, config);
  await notifier("market message", "market");

  assert.equal(sent.length, 1);
  const [chatId, , options] = sent[0];
  assert.equal(chatId, "-1002222222222");
  assert.deepEqual(options.link_preview_options, { is_disabled: false });
});

test("createNotifier: routes to squad chat when squad source is specified", async () => {
  const sent = [];
  const mockBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
      },
    },
  };

  const config = baseConfig({
    chatId: "-1001111111111",
    squadChatId: "-1003333333333",
    linkPreviewSquad: true,
  });
  const notifier = createNotifier(mockBot, config);
  await notifier("squad message", "squad");

  assert.equal(sent.length, 1);
  const [chatId, , options] = sent[0];
  assert.equal(chatId, "-1003333333333");
  assert.deepEqual(options.link_preview_options, { is_disabled: false });
});

test("previewMessage: shows link preview disabled for market (default)", () => {
  const message = previewMessage(
    baseConfig({ linkPreviewMarket: false }),
    "market"
  );

  assert.ok(message.includes("Link previews: disabled"), "should show disabled status");
});

test("previewMessage: shows link preview enabled for market when configured", () => {
  const message = previewMessage(
    baseConfig({ linkPreviewMarket: true }),
    "market"
  );

  assert.ok(message.includes("Link previews: enabled"), "should show enabled status");
});

test("previewMessage: shows link preview disabled for squad (default)", () => {
  const message = previewMessage(
    baseConfig({ linkPreviewSquad: false }),
    "squad"
  );

  assert.ok(message.includes("Link previews: disabled"), "should show disabled status");
});

test("previewMessage: shows link preview enabled for squad when configured", () => {
  const message = previewMessage(
    baseConfig({ linkPreviewSquad: true }),
    "squad"
  );

  assert.ok(message.includes("Link previews: enabled"), "should show enabled status");
});

test("previewMessage: includes sample market event in output", () => {
  const message = previewMessage(baseConfig(), "market");

  assert.ok(
    message.includes("claim_created") || message.includes("crypto"),
    "should include market event details"
  );
});

test("previewMessage: includes sample squad event in output", () => {
  const message = previewMessage(baseConfig(), "squad");

  assert.ok(
    message.includes("market_created") || message.includes("Stellar"),
    "should include squad event details"
  );
});

test("createNotifier: plain text fallback respects link preview settings", async () => {
  const sent = [];
  const mockBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        // First call throws, second call succeeds (plain text fallback)
        if (sent.length === 1) {
          throw {
            error_code: 400,
            description: "Bad Request: can't parse entities: test error",
          };
        }
      },
    },
  };

  const config = baseConfig({ linkPreviewMarket: true });
  const notifier = createNotifier(mockBot, config);

  // Suppress console warnings during the test
  const original = console.warn;
  console.warn = () => {};
  try {
    await notifier("test message", "market", { plainText: "fallback" });
  } finally {
    console.warn = original;
  }

  assert.equal(sent.length, 2);
  
  // First send (MarkdownV2) should have link previews enabled
  const [, , firstOptions] = sent[0];
  assert.deepEqual(firstOptions.link_preview_options, { is_disabled: false });

  // Fallback (plain text) should also respect the setting by keeping it consistent
  const [, , secondOptions] = sent[1];
  assert.deepEqual(secondOptions.link_preview_options, { is_disabled: false });
});

test("createNotifier: market and squad can have independent settings", async () => {
  const marketSent = [];
  const squadSent = [];

  const mockBotMarket = {
    api: {
      sendMessage: async (...args) => {
        marketSent.push(args);
      },
    },
  };

  const mockBotSquad = {
    api: {
      sendMessage: async (...args) => {
        squadSent.push(args);
      },
    },
  };

  const config = baseConfig({ linkPreviewMarket: true, linkPreviewSquad: false });

  const notifierMarket = createNotifier(mockBotMarket, config);
  const notifierSquad = createNotifier(mockBotSquad, config);

  await notifierMarket("market msg", "market");
  await notifierSquad("squad msg", "squad");

  assert.deepEqual(marketSent[0][2].link_preview_options, { is_disabled: false });
  assert.deepEqual(squadSent[0][2].link_preview_options, { is_disabled: true });
});

test("previewMessage: respects independent market/squad settings", () => {
  const config = baseConfig({ linkPreviewMarket: true, linkPreviewSquad: false });

  const marketMessage = previewMessage(config, "market");
  const squadMessage = previewMessage(config, "squad");

  assert.ok(marketMessage.includes("Link previews: enabled"));
  assert.ok(squadMessage.includes("Link previews: disabled"));
});

test("createNotifier: backward compatibility - both disabled by default", async () => {
  const sent = [];
  const mockBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
      },
    },
  };

  // Default config (no overrides for link preview settings)
  const config = baseConfig();
  const notifier = createNotifier(mockBot, config);

  await notifier("test", "market");
  await notifier("test", "squad");
  await notifier("test");

  assert.equal(sent.length, 3);
  // All should have link previews disabled (backward compatible)
  for (const [, , options] of sent) {
    assert.deepEqual(options.link_preview_options, { is_disabled: true });
  }
});
