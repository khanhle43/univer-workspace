/**
 * WebSocket host resolution.
 *
 * Collaboration and worktree realtime connections are served by a long-lived
 * realtime server (Docker/VM), separate from the Vercel serverless front that
 * serves HTTP. When `VITE_WS_HOST` is set at build time the browser opens its
 * WebSockets there; otherwise it falls back to the current page origin (same-host
 * deployments where one origin serves both HTTP and WS).
 */

function resolveWsOrigin(): string {
  const configured = import.meta.env.VITE_WS_HOST as string | undefined;
  const host = (configured ?? "").trim();
  if (!host) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
  }
  // Accept a bare host ("ws.example.com") or a full URL ("wss://ws.example.com").
  if (/^wss?:\/\//i.test(host)) return host;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${host}`;
}

export function wsOrigin(): string {
  return resolveWsOrigin();
}
