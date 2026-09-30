import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOG_FORMAT,
  DEFAULT_LOG_LEVEL,
  LOG_FORMAT_ENV,
  LOG_LEVEL_ENV,
  MAX_LOG_FIELD_CHARS,
  Logger,
  parseLogFormat,
  parseLogLevel,
} from "../dist/logger.js";

/** Collect rendered lines instead of writing to the process's own streams. */
function captureConsole() {
  const lines = [];
  Logger.configure({ sink: (level, line) => lines.push({ level, line }) });
  return lines;
}

test.afterEach(() => {
  Logger.reset();
});

test("defaults keep the process quiet only below info, and render text", () => {
  assert.equal(DEFAULT_LOG_LEVEL, "info");
  assert.equal(DEFAULT_LOG_FORMAT, "text");
  Logger.reset();
  assert.equal(Logger.getLevel(), "info");
  assert.equal(Logger.getFormat(), "text");
});

test("parseLogLevel accepts the five levels, case-insensitively", () => {
  assert.equal(parseLogLevel("debug"), "debug");
  assert.equal(parseLogLevel("INFO"), "info");
  assert.equal(parseLogLevel(" warn "), "warn");
  assert.equal(parseLogLevel("error"), "error");
  assert.equal(parseLogLevel("fatal"), "fatal");
});

test("parseLogLevel falls back to the default rather than silencing logs", () => {
  // A typo in a deployment must not turn logging off entirely.
  assert.equal(parseLogLevel("verbose"), DEFAULT_LOG_LEVEL);
  assert.equal(parseLogLevel(""), DEFAULT_LOG_LEVEL);
  assert.equal(parseLogLevel(undefined), DEFAULT_LOG_LEVEL);
  assert.equal(parseLogLevel(null), DEFAULT_LOG_LEVEL);
});

test("parseLogFormat only accepts json, and defaults to text", () => {
  assert.equal(parseLogFormat("json"), "json");
  assert.equal(parseLogFormat(" JSON "), "json");
  assert.equal(parseLogFormat("text"), "text");
  assert.equal(parseLogFormat("yaml"), DEFAULT_LOG_FORMAT);
  assert.equal(parseLogFormat(undefined), DEFAULT_LOG_FORMAT);
});

test("text format emits exactly the message a console call would have", () => {
  const lines = captureConsole();
  Logger.info("poller", "[poller] watching market=C1 squad=C2 every 5000ms", {
    marketContractId: "C1",
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, "[poller] watching market=C1 squad=C2 every 5000ms");
  assert.equal(lines[0].level, "info");
});

test("level filtering drops below the threshold and keeps above it", () => {
  Logger.configure({ level: "warn" });
  const lines = captureConsole();
  Logger.debug("x", "debug");
  Logger.info("x", "info");
  Logger.warn("x", "warn");
  Logger.error("x", "error");
  Logger.fatal("x", "fatal");
  assert.deepEqual(
    lines.map((l) => l.level),
    ["warn", "error", "fatal"],
  );
});

test("fatal survives the strictest threshold", () => {
  Logger.configure({ level: "fatal" });
  const lines = captureConsole();
  Logger.error("x", "error");
  Logger.fatal("x", "fatal");
  assert.deepEqual(lines.map((l) => l.level), ["fatal"]);
});

test("json format emits one parseable object per line with the fields", () => {
  Logger.configure({ format: "json", now: () => new Date("2026-01-02T03:04:05.000Z") });
  const lines = captureConsole();
  Logger.info("poller", "[poller] resumed from /tmp/cursor", {
    action: "resume",
    targets: [{ source: "market", cursor: "123-0" }],
  });

  assert.equal(lines.length, 1);
  assert.ok(!lines[0].line.includes("\n"), "one record is one line");
  const record = JSON.parse(lines[0].line);
  assert.equal(record.ts, "2026-01-02T03:04:05.000Z");
  assert.equal(record.level, "info");
  assert.equal(record.component, "poller");
  assert.equal(record.msg, "[poller] resumed from /tmp/cursor");
  assert.equal(record.action, "resume");
  assert.deepEqual(record.targets, [{ source: "market", cursor: "123-0" }]);
});

test("the canonical keys cannot be shadowed by a caller's fields", () => {
  Logger.configure({ format: "json" });
  const lines = captureConsole();
  Logger.warn("real", "real message", { level: "info", component: "fake", msg: "fake" });
  const record = JSON.parse(lines[0].line);
  assert.equal(record.level, "warn");
  assert.equal(record.component, "real");
  assert.equal(record.msg, "real message");
});

test("a registered secret is redacted in the message and in every field", () => {
  const token = "123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII";
  Logger.configure({ format: "json", secrets: [token] });
  const lines = captureConsole();
  Logger.fatal("process", `[fatal] telegram long-polling failed: ${token}`, {
    error: `401 from https://api.telegram.org/bot${token}/getUpdates`,
    nested: { token },
  });
  assert.ok(!lines[0].line.includes(token), "the token must not survive anywhere");
  const record = JSON.parse(lines[0].line);
  assert.match(record.msg, /\[REDACTED\]/);
  assert.match(record.error, /\[REDACTED\]/);
  assert.equal(record.nested.token, "[REDACTED]");
});

test("a Telegram-shaped token is redacted even when its value is not registered", () => {
  // The process handlers run before config is loaded, so they cannot register
  // the token — the shape has to be enough.
  const lines = captureConsole();
  Logger.configure({ format: "json" });
  Logger.error("process", "[error] unhandled rejection: 9876543210:AbCdEfGhIjKlMnOpQrStUvWx", {});
  assert.ok(!lines[0].line.includes("AbCdEfGhIjKlMnOpQrStUvWx"));
  assert.match(lines[0].line, /\[REDACTED\]/);
});

test("text format redacts too, not only json", () => {
  const token = "55555:QQQQQQQQQQQQQQQQQQQQQQQQ";
  Logger.configure({ format: "text", secrets: [token] });
  const lines = captureConsole();
  Logger.error("x", `failed with ${token}`);
  assert.equal(lines[0].line, "failed with [REDACTED]");
});

test("fields are JSON-safe: bigint stringified, undefined dropped, depth bounded", () => {
  Logger.configure({ format: "json" });
  const lines = captureConsole();
  const cyclic = { name: "deep" };
  cyclic.self = cyclic;
  Logger.info("x", "msg", {
    amount: 20_000_000n,
    absent: undefined,
    missing: null,
    cyclic,
  });
  const record = JSON.parse(lines[0].line);
  assert.equal(record.amount, "20000000");
  assert.ok(!("absent" in record), "undefined is dropped rather than serialized");
  assert.equal(record.missing, null);
  // A cyclic field is bounded by depth instead of throwing in JSON.stringify:
  // `cyclic` sits at depth 0, so four levels down the cycle is cut.
  assert.equal(record.cyclic.name, "deep");
  assert.equal(record.cyclic.self.self.self.self, "[depth-limit]");
});

test("a long field is truncated to the log field budget", () => {
  Logger.configure({ format: "json" });
  const lines = captureConsole();
  Logger.info("x", "msg", { reason: "r".repeat(MAX_LOG_FIELD_CHARS * 2) });
  const record = JSON.parse(lines[0].line);
  assert.equal(record.reason.length, MAX_LOG_FIELD_CHARS);
  assert.ok(record.reason.endsWith("…"));
});

test("a field that cannot be serialized degrades to the message, never throws", () => {
  Logger.configure({ format: "json" });
  const lines = captureConsole();
  const hostile = {};
  Object.defineProperty(hostile, "boom", {
    enumerable: true,
    get() {
      throw new Error("getter blew up");
    },
  });
  assert.doesNotThrow(() => Logger.info("x", "still logged", { hostile }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, "still logged");
});

test("configureFromEnv reads the level and format variables", () => {
  Logger.configureFromEnv({ [LOG_LEVEL_ENV]: "ERROR", [LOG_FORMAT_ENV]: "json" });
  assert.equal(Logger.getLevel(), "error");
  assert.equal(Logger.getFormat(), "json");

  Logger.configureFromEnv({ [LOG_LEVEL_ENV]: "nonsense", [LOG_FORMAT_ENV]: "nonsense" });
  assert.equal(Logger.getLevel(), DEFAULT_LOG_LEVEL);
  assert.equal(Logger.getFormat(), DEFAULT_LOG_FORMAT);
});

test("reset restores the defaults and drops registered secrets", () => {
  const token = "123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII";
  Logger.configure({ level: "debug", format: "json", secrets: [token] });
  Logger.reset();
  assert.equal(Logger.getLevel(), DEFAULT_LOG_LEVEL);
  assert.equal(Logger.getFormat(), DEFAULT_LOG_FORMAT);
  const lines = captureConsole();
  Logger.info("x", token);
  // Text default, and the shape regex still catches it.
  assert.equal(lines[0].line, "[REDACTED]");
});
