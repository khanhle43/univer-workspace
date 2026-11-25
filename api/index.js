// Vercel serverless entrypoint for Univer Workspace.
//
// Serverless functions cannot hold long-lived WebSocket connections or persistent
// background tasks, so this entrypoint initializes the Express application once per
// warm function instance and forwards every HTTP request to it. Real-time multi-user
// WebSocket sync is intentionally omitted; single-user editing and collaboration
// changeset/snapshot HTTP endpoints work against Supabase Postgres + S3.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import Module from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const preloadedEsmByPath = new Map();
let esmSupportInstalled = false;

function installRequireEsmExtensions() {
  if (esmSupportInstalled) return;
  esmSupportInstalled = true;

  const compileAsEsm = (mod, filename) => {
    if (preloadedEsmByPath.has(filename)) {
      mod.exports = preloadedEsmByPath.get(filename);
      return;
    }
    const source = readFileSync(filename, "utf8");
    return mod._compile(source, filename, "module");
  };

  const prevJs = Module._extensions[".js"];
  if (typeof prevJs === "function") {
    Module._extensions[".js"] = function patchedJsExtension(mod, filename) {
      try {
        return prevJs.call(this, mod, filename);
      } catch (err) {
        if (err && err.code === "ERR_REQUIRE_ESM") {
          return compileAsEsm(mod, filename);
        }
        throw err;
      }
    };
  }

  const prevMjs = Module._extensions[".mjs"];
  Module._extensions[".mjs"] = function patchedMjsExtension(mod, filename) {
    if (typeof prevMjs === "function") {
      try {
        return prevMjs.call(this, mod, filename);
      } catch (err) {
        if (!err || err.code !== "ERR_REQUIRE_ESM") throw err;
      }
    }
    return compileAsEsm(mod, filename);
  };
}

function supportsSyncCompileModule() {
  try {
    const probe = new Module("/tmp/__esm_probe.mjs");
    probe.filename = "/tmp/__esm_probe.mjs";
    probe._compile("export const ok = 1;", "/tmp/__esm_probe.mjs", "module");
    return probe.exports?.ok === 1;
  } catch {
    return false;
  }
}

async function preloadPnpmEsmPackagesFallback() {
  const pnpmRoot = resolve(process.cwd(), "node_modules/.pnpm");
  if (!existsSync(pnpmRoot)) return;

  const pkgDirs = [];
  for (const storeEntry of readdirSync(pnpmRoot, { withFileTypes: true })) {
    if (!storeEntry.isDirectory()) continue;
    const nmDir = join(pnpmRoot, storeEntry.name, "node_modules");
    if (!existsSync(nmDir)) continue;
    for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith("@")) {
        const scopeDir = join(nmDir, entry.name);
        if (!existsSync(scopeDir)) continue;
        for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
          pkgDirs.push(join(scopeDir, sub.name));
        }
      } else {
        pkgDirs.push(join(nmDir, entry.name));
      }
    }
  }

  for (const pkgDir of pkgDirs) {
    const pjPath = join(pkgDir, "package.json");
    if (!existsSync(pjPath)) continue;
    let pj;
    try {
      pj = JSON.parse(readFileSync(pjPath, "utf8"));
    } catch {
      continue;
    }
    if (pj.type !== "module") continue;
    try {
      const dummyParent = new Module(join(pkgDir, "__resolver__.cjs"));
      dummyParent.filename = dummyParent.id;
      dummyParent.paths = Module._nodeModulePaths(dirname(dummyParent.id));
      const entryFile = Module._resolveFilename(pkgDir, dummyParent, false);
      if (!preloadedEsmByPath.has(entryFile)) {
        const ns = await import(pathToFileURL(entryFile).href);
        preloadedEsmByPath.set(entryFile, ns);
      }
    } catch {
      // Ignore packages without a default root export or side-effect-only packages.
    }
  }
}

async function ensureRequireEsmSupport() {
  installRequireEsmExtensions();
  if (!supportsSyncCompileModule()) {
    await preloadPnpmEsmPackagesFallback();
  }
}

function normalizeBooleanEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    delete process.env[name];
    return;
  }
  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") {
    process.env[name] = "true";
  } else if (lower === "false" || lower === "0" || lower === "no") {
    process.env[name] = "false";
  } else {
    process.env[name] = raw;
  }
}

function normalizeEnvironment() {
  if (!process.env.PUBLIC_ORIGIN) {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    if (host) process.env.PUBLIC_ORIGIN = `https://${host}`;
  }
  normalizeBooleanEnv("BLOB_S3_FORCE_PATH_STYLE");
  normalizeBooleanEnv("SECURE_COOKIES");
  normalizeBooleanEnv("PASSWORD_AUTH_ENABLED");
  if (process.env.BLOB_S3_ENDPOINT?.includes(".storage.supabase.co") && !process.env.BLOB_S3_FORCE_PATH_STYLE) {
    process.env.BLOB_S3_FORCE_PATH_STYLE = "true";
  }
  if (!process.env.BLOB_S3_REGION && process.env.AWS_REGION) {
    process.env.BLOB_S3_REGION = process.env.AWS_REGION;
  }
  if (!process.env.BLOB_S3_REGION && process.env.BLOB_S3_ENDPOINT) {
    process.env.BLOB_S3_REGION = "us-east-1";
  }
  if (!process.env.AWS_REGION && process.env.BLOB_S3_REGION) {
    process.env.AWS_REGION = process.env.BLOB_S3_REGION;
  }
}

function buildPostgresCandidates(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [rawUrl];
  }

  // pg-connection-string@2.x treats sslmode=require without uselibpqcompat=true as
  // verify-full, which rejects Supabase's internal CA chain on serverless.
  if (parsed.searchParams.get("sslmode") === "require" && !parsed.searchParams.has("uselibpqcompat")) {
    parsed.searchParams.set("uselibpqcompat", "true");
  }

  const candidates = [];

  // Direct Supabase hosts (db.<ref>.supabase.co) are IPv6-only on Free tier, while
  // Vercel serverless functions only have IPv4 outbound connectivity. Derive the
  // Supavisor IPv4 Session Mode pooler candidates automatically if a direct URL is supplied.
  const directMatch = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname);
  if (directMatch) {
    const projectRef = directMatch[1];
    const region = process.env.SUPABASE_REGION || "ap-southeast-1";
    for (const shard of ["aws-1", "aws-0"]) {
      const pooler = new URL(parsed.href);
      pooler.hostname = `${shard}-${region}.pooler.supabase.com`;
      pooler.port = "5432";
      if (!pooler.username.includes(".")) {
        pooler.username = `${pooler.username || "postgres"}.${projectRef}`;
      }
      if (!pooler.searchParams.has("sslmode")) {
        pooler.searchParams.set("sslmode", "require");
        pooler.searchParams.set("uselibpqcompat", "true");
      }
      candidates.push(pooler.href);
    }
    candidates.push(parsed.href);
    return candidates;
  }

  candidates.push(parsed.href);

  // If a Supavisor pooler shard is specified (aws-0 or aws-1), include the sibling
  // shard as a fallback in case the project lives on the other regional shard.
  const poolerMatch = /^aws-([01])-([a-z0-9-]+)\.pooler\.supabase\.com$/i.exec(parsed.hostname);
  if (poolerMatch) {
    const siblingShard = poolerMatch[1] === "1" ? "0" : "1";
    const sibling = new URL(parsed.href);
    sibling.hostname = `aws-${siblingShard}-${poolerMatch[2]}.pooler.supabase.com`;
    candidates.push(sibling.href);
  }

  return candidates;
}

async function openPostgresWithFallback(openPostgresProductDatabase, connectionString) {
  const candidates = buildPostgresCandidates(connectionString);
  const errors = [];
  for (const candidate of candidates) {
    try {
      const database = await openPostgresProductDatabase({
        provider: "postgres",
        connectionString: candidate,
      });
      return { database, connectionString: candidate };
    } catch (error) {
      const host = (() => {
        try {
          return new URL(candidate).hostname;
        } catch {
          return "unknown";
        }
      })();
      errors.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`All PostgreSQL connection candidates failed: ${errors.join(" | ")}`);
}

function restoreRewrittenUrl(req) {
  if (!req.url) return;
  const parsed = new URL(req.url, "http://localhost");
  const vpath = parsed.searchParams.get("__vpath");
  if (vpath !== null) {
    parsed.searchParams.delete("__vpath");
    const search = parsed.searchParams.toString();
    const normalizedPath = vpath.startsWith("/") ? vpath : `/${vpath}`;
    req.url = search ? `${normalizedPath}?${search}` : normalizedPath;
  }
}

function redactSecrets(text) {
  let out = String(text ?? "");
  out = out.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://[REDACTED]");
  for (const key of ["DATABASE_URL", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID"]) {
    const val = process.env[key];
    if (val && val.length >= 4) {
      out = out.split(val).join("[REDACTED]");
    }
  }
  return out;
}

let appPromise = null;

async function boot() {
  await ensureRequireEsmSupport();
  normalizeEnvironment();
  const [
    { loadConfig },
    { openPostgresProductDatabase },
    { openPostgresCollaborationDatabase },
    { createWorkspaceApplication },
  ] = await Promise.all([
    import("../apps/workspace/dist/server/config.js"),
    import("../apps/workspace/dist/server/db/postgres/open.js"),
    import("../apps/workspace/dist/server/integrations/univer/collaboration-database/postgres/open.js"),
    import("../apps/workspace/dist/server/app.js"),
  ]);

  const config = loadConfig();
  if (config.database.provider !== "postgres" || !config.s3BlobStore) {
    throw new Error("Vercel serverless deployment requires DATABASE_PROVIDER=postgres and BLOB_STORE=s3");
  }
  const { database, connectionString } = await openPostgresWithFallback(
    openPostgresProductDatabase,
    config.database.connectionString,
  );
  let collaboration;
  try {
    collaboration = await openPostgresCollaborationDatabase(connectionString, config.s3BlobStore);
    const application = createWorkspaceApplication(config, database.repositories, collaboration);
    await application.initialize();
    return application.app;
  } catch (error) {
    await collaboration?.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}

export default async function handler(req, res) {
  restoreRewrittenUrl(req);
  const parsedUrl = new URL(req.url || "/", "http://localhost");
  const isDiagHealth = parsedUrl.pathname === "/healthz" && parsedUrl.searchParams.get("diag") === "1";

  try {
    if (!appPromise) {
      appPromise = boot().catch((error) => {
        appPromise = null;
        throw error;
      });
    }
    const app = await appPromise;
    if (isDiagHealth) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>Univer Workspace Health</title><pre>STATUS: OK</pre>");
      return;
    }
    return app(req, res);
  } catch (error) {
    const summary = redactSecrets(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error));
    console.error("Workspace serverless boot failed:", summary);
    if (isDiagHealth) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><title>Univer Workspace Boot Error</title><pre>${summary.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`);
      return;
    }
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { code: "BOOT_FAILED", message: redactSecrets(error instanceof Error ? error.message : String(error)) } }));
  }
}
