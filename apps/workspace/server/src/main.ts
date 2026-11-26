import type { CollaborationDatabase } from "./integrations/univer/collaboration-database/collaboration-database.js";
import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { openProductDatabase, type ProductDatabase } from "./db/index.js";
import { startOperationRecovery, type OperationRecovery } from "./jobs/operation-recovery.js";
import { startBlobMaintenance } from "./jobs/blob-maintenance.js";
import { startIssueAcceptance } from "./jobs/issue-acceptance.js";
import { PostgresSessionTicketStore } from "./integrations/realtime/postgres-session-ticket-store.js";
import { shutdownServer } from "./server-lifecycle.js";
import { logger } from "./logging/logger.js";
import { beginStartupStage, startupStage, startupStageAsync } from "./logging/startup.js";

// 只在 SDK 和应用模块加载边界保留动态导入，以记录初始化前的失败。
const { openCollaborationDatabase } = await startupStageAsync(
  "modules.collaboration-database",
  () => import("./integrations/univer/collaboration-database/open-collaboration-database.js"),
);
const { createWorkspaceApplication } = await startupStageAsync(
  "modules.application",
  () => import("./app.js"),
);
const config = startupStage("config.load", () => loadConfig());
if (config.emailAuth?.provider === "console") {
  logger.warn(
    "Email sign-in uses the console provider; verification codes are written to the server log. Configure SMTP before using it in production."
  );
}
const database = await startupStageAsync("database.product.prepare", () =>
  openProductDatabase(config.database),
);
try {
  const collaboration = await startupStageAsync("database.collaboration.prepare", () =>
    openCollaborationDatabase(config, database.unitCreationFacts),
  );
  try {
    await serve(database, collaboration);
  } finally {
    await collaboration.close();
  }
} finally {
  await database.close();
}

async function serve(product: ProductDatabase, collaboration: CollaborationDatabase): Promise<void> {
  // Shared session ticket store so tickets issued on the HTTP session-ticket route
  // are consumable on the WebSocket upgrade. Uses Postgres so the store is shared
  // across processes (HTTP front vs. long-lived realtime server).
  const ticketStore =
    config.database.provider === "postgres"
      ? new PostgresSessionTicketStore(config.database.connectionString)
      : undefined;
  try {
    const application = startupStage("application.create", () =>
      createWorkspaceApplication(config, product.repositories, collaboration, {
        ...(ticketStore ? { ticketStore } : {}),
      }),
    );
    const server = createServer(application.app);
    const jobs: OperationRecovery[] = [];
    try {
      await startupStageAsync("application.initialize", () => application.initialize());
      jobs.push(startOperationRecovery(application.resources));
      jobs.push(startOperationRecovery(application.copies));
      jobs.push(startOperationRecovery(application.reverts));
      jobs.push(startBlobMaintenance(application.blobs, {
        drafts: application.htmlViewDrafts,
        skillDrafts: application.skillDrafts,
        univerAssets: application.univerAssets,
      }));
      jobs.push(startIssueAcceptance(application.issues));
      application.attachWebSocket(server);

      const logListen = beginStartupStage("server.listen");
      const stop = new AbortController();
      const onSignal = () => stop.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        await new Promise<void>((resolve, reject) => {
          stop.signal.addEventListener("abort", () => {
            if (server.listening) resolve();
          }, { once: true });
          server.once("error", reject);
          server.listen(config.port, config.host, () => {
            logListen("completed");
            logger.info({ host: config.host, port: config.port }, "Univer Workspace is running");
            ticketStore?.startSweeper();
            // A signal during hostname resolution must still drain the newly opened listener.
            if (stop.signal.aborted) resolve();
          });
        });
      } catch (error) {
        if (!server.listening) logListen("failed", error);
        throw error;
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    } finally {
      await shutdownServer(server, {
        async dispose() {
          await Promise.all(jobs.map((job) => job.dispose()));
          await ticketStore?.dispose();
        },
      }, application);
    }
  } finally {
    await ticketStore?.dispose();
  }
}
