/**
 * Entry point: config -> RPC client -> bot -> poller.
 *
 * Startup is fail-fast (a bad config exits non-zero with the reasons listed);
 * everything after startup is fail-soft, because the whole point of this process
 * is to still be running next week.
 */

import { ConfigError, loadConfig, networkLabel } from "./config.js";
import { createBot, createNotifier, registerCommands } from "./bot.js";
import { createPoller } from "./poller.js";
import { createRpcServer } from "./stellar/client.js";
import { log } from "./log.js";

/**
 * Installed before anything else can throw, so a rejection during startup is
 * reported rather than printed by Node as a bare stack trace.
 */
function installProcessHandlers(): void {
  // A rejected promise nobody awaited is a bug, but not a reason to stop
  // notifying. Log it and let the poll loop carry on.
  process.on("unhandledRejection", (reason) => {
    log.error("[error] unhandled rejection:", reason);
  });

  // An uncaught exception means state is unknown; exit so the supervisor
  // restarts us. The persisted cursor is what makes that cheap.
  process.on("uncaughtException", (err) => {
    log.error("[fatal] uncaught exception, exiting for restart:", err);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  installProcessHandlers();

  const config = loadConfig();

  log.info(`[boot] Mimir Telegram notifier`);
  log.info(`[boot] network      ${networkLabel(config)} (${config.rpcUrl})`);
  log.info(`[boot] market       ${config.marketContractId}`);
  log.info(`[boot] squad        ${config.squadContractId}`);
  // Chat id is operational metadata, not a secret — but we do NOT log the bot
  // token here. The token is already excluded from boot-time diagnostics.
  log.info(`[boot] chat         ${config.chatId}`);
  log.info(`[boot] cursor file  ${config.cursorFile}`);

  const server = createRpcServer(config);

  // One read before announcing readiness: a wrong RPC URL should surface now,
  // not as a mystery in the poll log an interval later.
  const health = await server.getHealth();
  log.info(
    `[boot] rpc ok, status=${health.status} ledgers ${health.oldestLedger}..${health.latestLedger}`,
  );

  // The bot needs the poller's status and the poller needs the bot's send path,
  // so one edge of the cycle is late-bound. This one, because it is the only
  // one that is a single function reference.
  let notify: (text: string) => Promise<void> = async () => {
    throw new Error("telegram notifier not ready");
  };

  const poller = createPoller({ config, server, send: (text) => notify(text) });
  const bot = createBot({ config, status: () => poller.status() });
  notify = createNotifier(bot, config);

  await registerCommands(bot);

  // grammy's `start` resolves only when the bot stops, so it is not awaited.
  // It retries transient network trouble internally; a rejection here means the
  // token itself cannot authenticate, which no amount of waiting fixes.
  void bot
    .start({
      onStart: (me) => log.info(`[boot] telegram ok, running as @${me.username}`),
    })
    .catch((err: unknown) => {
      log.error("[fatal] telegram long-polling failed — check BOT_TOKEN:", err);
      process.exit(1);
    });

  await poller.start();

  const shutdown = (signal: string) => {
    log.info(`[shutdown] ${signal} received, stopping`);
    poller.stop();
    void bot.stop().finally(() => process.exit(0));
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  log.error("[boot] startup failed:", err);
  process.exit(1);
});
