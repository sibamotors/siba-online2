/**
 * Adds browser security headers to every response (Nitro middleware, runs on
 * Render). Dynamic data endpoints are also marked "no-store" so private data is
 * never kept in a shared cache.
 *
 * If CSP blocks a legitimate feature, inspect the browser console and adjust this
 * allowlist. DISABLE_CSP=1 is for short, controlled diagnosis only; never leave it
 * enabled in production, because it disables a major defense-in-depth layer.
 */
interface SecurityEvent {
  url: URL;
  req: { method: string; headers: Headers };
}

const CSP = [
  "default-src 'self'",
  // TanStack Start streams small inline scripts/styles for hydration.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};
if (process.env.DISABLE_CSP !== "1") HEADERS["content-security-policy"] = CSP;

export default async function securityHeaders(
  event: SecurityEvent,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const result = await next();
  if (!(result instanceof Response)) return result;
  const headers = new Headers(result.headers);
  for (const [name, value] of Object.entries(HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  // Private app HTML and server-function responses must never be stored by a
  // shared proxy/browser cache. Static assets keep their normal cache policy.
  if (headers.get("content-type")?.toLowerCase().includes("text/html") || event.url.pathname.startsWith("/_serverFn")) {
    headers.set("cache-control", "private, no-store, max-age=0");
    headers.set("pragma", "no-cache");
  }
  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers,
  });
}
