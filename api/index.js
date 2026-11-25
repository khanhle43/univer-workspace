// Vercel serverless entrypoint for Univer Workspace.
//
// Serverless functions cannot hold long-lived WebSocket connections or persistent
// background tasks, so this entrypoint initializes the Express application once per
// warm function instance and forwards every HTTP request to it. Real-time multi-user
// WebSocket sync is intentionally omitted; single-user editing and collaboration
// changeset/snapshot HTTP endpoints work against Supabase Postgres + S3.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import Module from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const preloadedEsmByPath = new Map();
const cjsExportsRegistry = (globalThis.__univerCjsExports ??= new Map());
const cjsRequire = Module.createRequire(import.meta.url);
let moduleHooksInstalled = false;

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_WORDS = new Set([
  "default", "break", "case", "catch", "class", "const", "continue", "debugger",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
  "yield", "let", "static", "implements", "interface", "package", "private", "protected",
  "public", "await", "__esModule",
]);
const FUNCTION_INTRINSICS = new Set(["length", "name", "prototype", "arguments", "caller"]);

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function lookupPreloadedEsm(filename) {
  if (preloadedEsmByPath.has(filename)) return preloadedEsmByPath.get(filename);
  const real = safeRealpath(filename);
  if (preloadedEsmByPath.has(real)) return preloadedEsmByPath.get(real);
  return undefined;
}

function installModuleCompatibilityHooks() {
  if (moduleHooksInstalled) return;
  moduleHooksInstalled = true;

  // 1. Vercel's Rust Node launcher (/opt/rust/nodejs.js) overrides Module.prototype.load
  //    and throws ERR_REQUIRE_ESM before reaching Module._extensions[".js"], and
  //    /opt/rust/bytecode.js strips the 3rd `format` argument of Module.prototype._compile.
  //    Serve preloaded ESM namespaces synchronously from preloadedEsmByPath.
  const prevProtoLoad = Module.prototype.load;
  if (typeof prevProtoLoad === "function") {
    Module.prototype.load = function patchedProtoLoad(filename) {
      const preloaded = lookupPreloadedEsm(filename);
      if (preloaded !== undefined) {
        this.filename = filename;
        this.paths = Module._nodeModulePaths(dirname(filename));
        this.exports = preloaded;
        this.loaded = true;
        return;
      }
      return prevProtoLoad.call(this, filename);
    };
  }

  const prevJs = Module._extensions[".js"];
  if (typeof prevJs === "function") {
    Module._extensions[".js"] = function patchedJsExtension(mod, filename) {
      const preloaded = lookupPreloadedEsm(filename);
      if (preloaded !== undefined) {
        mod.exports = preloaded;
        return;
      }
      return prevJs.call(this, mod, filename);
    };
  }

  const prevMjs = Module._extensions[".mjs"];
  Module._extensions[".mjs"] = function patchedMjsExtension(mod, filename) {
    const preloaded = lookupPreloadedEsm(filename);
    if (preloaded !== undefined) {
      mod.exports = preloaded;
      return;
    }
    if (typeof prevMjs === "function") {
      return prevMjs.call(this, mod, filename);
    }
  };

  // 2. Vercel bytecode caching (VERCEL_USE_BYTECODE_CACHING) replaces CJS .js files
  //    on disk with bytecode stubs, so Node's static cjs-module-lexer sees zero named
  //    exports when an ESM module imports a CJS package. Use nextLoad() so Node's own
  //    parser distinguishes ESM (including typeless dual packages like @univerjs/protocol)
  //    from CommonJS, and never intercept require() calls.
  if (typeof Module.registerHooks === "function") {
    Module.registerHooks({
      load(url, context, nextLoad) {
        if (Array.isArray(context?.conditions) && context.conditions.includes("require")) {
          return nextLoad(url, context);
        }
        const loaded = nextLoad(url, context);
        if (
          loaded.format === "commonjs" &&
          url.startsWith("file://") &&
          url.includes("/node_modules/")
        ) {
          const filename = fileURLToPath(url);
          const exp = cjsRequire(filename);
          cjsExportsRegistry.set(url, exp);
          const lines = [
            `const __exp = globalThis.__univerCjsExports.get(${JSON.stringify(url)});`,
            `export default __exp;`,
          ];
          if ((exp && typeof exp === "object") || typeof exp === "function") {
            const isFn = typeof exp === "function";
            const rawKeys = new Set([
              ...Object.keys(exp),
              ...Object.getOwnPropertyNames(exp).filter((k) => !isFn || !FUNCTION_INTRINSICS.has(k)),
              ...(exp.default && typeof exp.default === "object" ? Object.keys(exp.default) : []),
            ]);
            for (const k of rawKeys) {
              if (IDENT_RE.test(k) && !RESERVED_WORDS.has(k)) {
                const keyLit = JSON.stringify(k);
                lines.push(
                  `export const ${k} = __exp[${keyLit}] !== undefined ? __exp[${keyLit}] : __exp?.default?.[${keyLit}];`,
                );
              }
            }
          }
          return { format: "module", shortCircuit: true, source: lines.join("\n") };
        }
        return loaded;
      },
    });
  }
}

function toCjsCompatibleEsmExports(ns) {
  // Match Node's native require(esm) behavior: attach __esModule: true iff default export exists.
  if (!ns || typeof ns !== "object") return ns;
  if (!("default" in ns)) return ns;
  if (ns.__esModule === true) return ns;
  const out = Object.create(null);
  Object.defineProperty(out, "__esModule", {
    value: true,
    writable: true,
    enumerable: true,
    configurable: false,
  });
  for (const key of Reflect.ownKeys(ns)) {
    if (key === "__esModule") continue;
    const desc = Object.getOwnPropertyDescriptor(ns, key);
    if (desc) Object.defineProperty(out, key, desc);
  }
  return out;
}

function registerPreloadedEsm(filePath, ns) {
  const wrapped = toCjsCompatibleEsmExports(ns);
  preloadedEsmByPath.set(filePath, wrapped);
  preloadedEsmByPath.set(safeRealpath(filePath), wrapped);
}

function collectPackageExportSpecifiers(pj, pkgDir) {
  const specs = new Set();
  const name = typeof pj.name === "string" ? pj.name : null;
  if (name) {
    if (typeof pj.exports === "string") {
      specs.add(name);
    } else if (pj.exports && typeof pj.exports === "object" && !Array.isArray(pj.exports)) {
      const keys = Object.keys(pj.exports);
      const hasSubpaths = keys.some((k) => k.startsWith("."));
      if (hasSubpaths) {
        for (const k of keys) {
          if (k === "./package.json" || k.includes("*")) continue;
          if (k === ".") {
            specs.add(name);
          } else if (k.startsWith("./")) {
            const sub = k.slice(2);
            specs.add(`${name}/${sub}`);
          }
        }
      } else {
        specs.add(name);
      }
    } else {
      specs.add(name);
    }
  } else {
    specs.add(pkgDir);
  }
  return [...specs];
}

async function preloadPnpmEsmPackages() {
  const apiDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    "/var/task/node_modules/.pnpm",
    resolve(process.cwd(), "node_modules/.pnpm"),
    resolve(apiDir, "../node_modules/.pnpm"),
  ];
  const pnpmRoot = candidates.find((p) => existsSync(p));
  if (!pnpmRoot) return;

  const pkgEntries = [];
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
          pkgEntries.push({ nmDir, pkgDir: join(scopeDir, sub.name) });
        }
      } else {
        pkgEntries.push({ nmDir, pkgDir: join(nmDir, entry.name) });
      }
    }
  }

  for (const { nmDir, pkgDir } of pkgEntries) {
    const pjPath = join(pkgDir, "package.json");
    if (!existsSync(pjPath)) continue;
    let pj;
    try {
      pj = JSON.parse(readFileSync(pjPath, "utf8"));
    } catch {
      continue;
    }
    if (pj.type !== "module") continue;
    if (typeof pj.name === "string" && (pj.name.startsWith("@babel/") || pj.name === "vite")) continue;

    const dummyParent = new Module(join(nmDir, "__resolver__.cjs"));
    dummyParent.filename = dummyParent.id;
    dummyParent.paths = [nmDir, ...Module._nodeModulePaths(nmDir)];

    for (const spec of collectPackageExportSpecifiers(pj, pkgDir)) {
      try {
        const entryFile = Module._resolveFilename(spec, dummyParent, false);
        if (!entryFile.endsWith(".cjs") && lookupPreloadedEsm(entryFile) === undefined) {
          const ns = await import(pathToFileURL(entryFile).href);
          registerPreloadedEsm(entryFile, ns);
        }
      } catch {
        // Ignore subpaths without CJS/default resolution or browser-only modules.
      }
    }

    // Also preload flat .js modules for subpath-imported ESM packages (e.g. lodash-es/debounce.js).
    if (!pj.exports || pj.name === "lodash-es" || pj.name?.startsWith("@noble/")) {
      try {
        for (const file of readdirSync(pkgDir, { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith(".js")) continue;
          const full = join(pkgDir, file.name);
          if (lookupPreloadedEsm(full) === undefined) {
            const ns = await import(pathToFileURL(full).href);
            registerPreloadedEsm(full, ns);
          }
        }
      } catch {
        // Ignore individual subfile failures.
      }
    }
  }
}

async function ensureModuleRuntimeSupport() {
  installModuleCompatibilityHooks();
  await preloadPnpmEsmPackages();
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

function extractNodeModulesSnippet(stack) {
  if (!stack) return "";
  const match = /(?:file:\/\/)?(\/var\/task\/node_modules\/[^\s:)]+):(\d+):(\d+)/.exec(stack);
  if (!match) return "";
  const [, filePath, lineStr] = match;
  try {
    if (!existsSync(filePath)) return "";
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const lineNum = Math.max(1, Number(lineStr));
    const start = Math.max(0, lineNum - 4);
    const end = Math.min(lines.length, lineNum + 4);
    const snippet = lines
      .slice(start, end)
      .map((l, idx) => `${start + idx + 1}: ${l.slice(0, 240)}`)
      .join("\n");
    return `\n\n--- ${filePath} ---\n${snippet}`;
  } catch {
    return "";
  }
}

let appPromise = null;

async function boot() {
  await ensureModuleRuntimeSupport();
  normalizeEnvironment();
  const { loadConfig } = await import("../apps/workspace/dist/server/config.js");
  const { openPostgresProductDatabase } = await import("../apps/workspace/dist/server/db/postgres/open.js");
  const { openPostgresCollaborationDatabase } = await import(
    "../apps/workspace/dist/server/integrations/univer/collaboration-database/postgres/open.js"
  );
  const { createWorkspaceApplication } = await import("../apps/workspace/dist/server/app.js");

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
    const rawMsg = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}${extractNodeModulesSnippet(error.stack)}` : String(error);
    const summary = redactSecrets(rawMsg);
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
