// Vercel serverless entrypoint for Univer Workspace.
//
// Vercel serverless functions cannot hold long-lived WebSocket connections or run
// persistent background jobs, so this entrypoint boots the Express application once
// per function instance (module-level singleton) and forwards every request to it.
// Real-time multi-user collaboration (the WebSocket gateway) is intentionally NOT
// attached here; single-user editing still works against Supabase Postgres + S3.

import { loadConfig } from "./apps/workspace/dist/server/config.js";
import { openProductDatabase } from "./apps/workspace/dist/server/db/index.js";
import { openCollaborationDatabase } from "./apps/workspace/dist/server/integrations/univer/collaboration-database/open-collaboration-database.js";
import { createWorkspaceApplication } from "./apps/workspace/dist/server/app.js";

type Handler = (req: unknown, res: unknown) => void;

let appPromise: Promise<Handler> | null = null;

async function boot(): Promise<Handler> {
  const config = loadConfig();
  const database = await openProductDatabase(config.database);
  const collaboration = await openCollaborationDatabase(config, database.unitCreationFacts);
  const application = createWorkspaceApplication(config, database.repositories, collaboration);
  await application.initialize();
  return application.app as unknown as Handler;
}

export default async function handler(req: any, res: any): Promise<unknown> {
  const app = await (appPromise ??= boot());
  return app(req, res);
}
