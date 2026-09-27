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
import { createMetrics } from "./metrics.js";
import type { MetricsServer } from "./metrics.js";

/**
 * Installed before anything else can throw, so a rejection during startup is
 * reported rather than printed by Node as a bare stack trace.
 */
function installProcessHandlers(): void {
  // A rejected promise nobody awaited is a bug, but not a reason to stop
  // notifying. Log it and let the poll loop carry on.
  process.on("unhandledRejection", (reason) => {
    console.error("[error] unhandled rejection:", reason);
  });

  // An uncaught exception means state is unknown; exit so the supervisor
  // restarts us. The persisted cursor is what makes that cheap.
  process.on("uncaughtException", (err) => {
    console.error("[fatal] uncaught exception, exiting for restart:", err);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  installProcessHandlers();

  const config = loadConfig();

  console.log(`[boot] Mimir Telegram notifier`);
  console.log(`[boot] network      ${networkLabel(config)} (${config.rpcUrl})`);
  console.log(`[boot] market       ${config.marketContractId}`);
  console.log(`[boot] squad        ${config.squadContractId}`);
  console.log(`[boot] chat         ${config.chatId}`);
  console.log(`[boot] cursor file  ${config.cursorFile}`);

  // ── Metrics ────────────────────────────────────────────────────────────────
  // Create the registry unconditionally; the HTTP server is only started when
  // METRICS_PORT is configured. This means the poller always has a metrics
  // object to call — no null checks needed there.
  const metrics = createMetrics();

  let metricsServer: MetricsServer | null = null;
  if (config.metricsPort !== null) {
    try {
      metricsServer = await metrics.startServer(config.metricsPort);
    } catch (err) {
      // Metrics are optional. A port conflict or privilege error must not
      // prevent the bot from starting — just log and continue.
      console.error(
        `[boot] metrics server failed to start on port ${config.metricsPort}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const server = createRpcServer(config);

  // One read before announcing readiness: a wrong RPC URL should surface now,
  // not as a mystery in the poll log an interval later.
  const health = await server.getHealth();
  console.log(
    `[boot] rpc ok, status=${health.status} ledgers ${health.oldestLedger}..${health.latestLedger}`,
  );

  // The bot needs the poller's status and the poller needs the bot's send path,
  // so one edge of the cycle is late-bound. This one, because it is the only
  // one that is a single function reference.
  let notify: (text: string) => Promise<void> = async () => {
    throw new Error("telegram notifier not ready");
  };

  const poller = createPoller({ config, server, send: (text) => notify(text), metrics });
  const bot = createBot({ config, status: () => poller.status() });
  notify = createNotifier(bot, config);

  await registerCommands(bot);

  // grammy's `start` resolves only when the bot stops, so it is not awaited.
  // It retries transient network trouble internally; a rejection here means the
  // token itself cannot authenticate, which no amount of waiting fixes.
  void bot
    .start({
      onStart: (me) => console.log(`[boot] telegram ok, running as @${me.username}`),
    })
    .catch((err: unknown) => {
      console.error("[fatal] telegram long-polling failed — check BOT_TOKEN:", err);
      process.exit(1);
    });

  await poller.start();

  const shutdown = (signal: string) => {
    console.log(`[shutdown] ${signal} received, stopping`);
    poller.stop();
    const stopBot = bot.stop().finally(() => process.exit(0));
    const stopMetrics = metricsServer ? metricsServer.close() : Promise.resolve();
    void Promise.all([stopBot, stopMetrics]);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  console.error("[boot] startup failed:", err);
  process.exit(1);
});
