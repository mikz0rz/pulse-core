import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";

const SESSION_COOKIE_NAME = "pulse_session";
const CSRF_COOKIE_NAME = "pulse_csrf";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Injected once by startTerminal — the core never reads these from the env.
//
// `enabled` defaults to true and is replaced wholesale by configureAuth, so a
// caller that omits it would leave it undefined — which is why every check
// below tests `=== false` rather than falsiness. Falsiness would read a missing
// field as "auth off", i.e. fail OPEN on exactly the deployment that most needs
// the gate. Only a literal false disables auth.
let authConfig = { enabled: true, appPassword: "", sessionSecret: "", secureCookie: false };

export function configureAuth(config: {
  enabled: boolean;
  appPassword: string;
  sessionSecret: string;
  secureCookie: boolean;
}): void {
  authConfig = config;
}

function getSecret(): string {
  if (!authConfig.sessionSecret) throw new Error("session secret not configured (call configureAuth)");
  return authConfig.sessionSecret;
}

function sign(expiresAt: number): string {
  return createHmac("sha256", getSecret()).update(String(expiresAt)).digest("hex");
}

function buildSessionValue(): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return `${expiresAt}.${sign(expiresAt)}`;
}

function isValidSessionValue(value: string | undefined): boolean {
  if (!value) return false;
  const [expiresAtStr, sig] = value.split(".");
  if (!expiresAtStr || !sig) return false;

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  const expected = sign(expiresAt);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

function setCsrfCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure,
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
  });
}

function getCsrfCookieValue(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[CSRF_COOKIE_NAME];
}

function csrfTokenMatches(req: Request): boolean {
  const cookieToken = getCsrfCookieValue(req);
  const headerToken = req.headers["x-csrf-token"];
  if (!cookieToken || typeof headerToken !== "string" || headerToken.length === 0) return false;
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(headerToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireCsrfToken(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    next();
    return;
  }
  if (!csrfTokenMatches(req)) {
    res.status(403).json({ error: "Invalid or missing CSRF token" });
    return;
  }
  next();
}

// Single-user tool exposed on the open internet — a small in-memory limiter
// on /login is cheap insurance, not a full rate-limiting subsystem.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

export function loginHandler(req: Request, res: Response): void {
  // With auth off there is no password to check and no session to mint, so this
  // route simply doesn't exist. Answering would also be a 500 waiting to happen:
  // a correct password would reach buildSessionValue() → getSecret(), which
  // throws when sessionSecret is empty — and a deployment that turned auth off
  // has no reason to keep one set. Returning early also keeps the login
  // rate-limit Map (entries are never evicted) from growing.
  if (authConfig.enabled === false) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // req.ip is the leftmost X-Forwarded-For entry when trust proxy is set; if
  // the proxy is not configured to strip untrusted values, fall back to the
  // raw TCP remote address so the rate limit bucket is not shared globally.
  const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
  if (isRateLimited(key)) {
    res.status(429).json({ error: "Too many attempts, try again later." });
    return;
  }

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const expected = authConfig.appPassword;
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  const matches = expected.length > 0 && a.length === b.length && timingSafeEqual(a, b);

  if (!matches) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  res.cookie(SESSION_COOKIE_NAME, buildSessionValue(), {
    httpOnly: true,
    secure: authConfig.secureCookie,
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
  });
  setCsrfCookie(res, generateCsrfToken(), authConfig.secureCookie);
  res.json({ ok: true });
}

export function logoutHandler(_req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ ok: true });
}

export function sessionStatusHandler(req: Request, res: Response): void {
  // The client gates the whole UI on this one field, so with auth off it must
  // report authenticated — otherwise the login screen renders against a server
  // that will never accept a password. authEnabled is returned in both modes so
  // the client can hide login-only chrome (the Log out button) without having
  // to infer it from a second request.
  if (authConfig.enabled === false) {
    res.json({ authenticated: true, authEnabled: false });
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  res.json({
    authenticated: isValidSessionValue(cookies[SESSION_COOKIE_NAME]),
    authEnabled: true,
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);

  if (authConfig.enabled === false) {
    // No login gate — but CSRF still guards the mutating routes, and its cookie
    // is normally handed out at login, which never happens here. Issue it from
    // this request instead. requireAuth fronts every read route, and the client
    // loads /api/lists before it can POST anything, so the cookie is always in
    // place before requireCsrfToken can ask for it.
    if (!cookies[CSRF_COOKIE_NAME]) {
      setCsrfCookie(res, generateCsrfToken(), authConfig.secureCookie);
    }
    next();
    return;
  }

  if (isValidSessionValue(cookies[SESSION_COOKIE_NAME])) {
    // Ensure existing sessions that predate the CSRF cookie get one.
    if (!cookies[CSRF_COOKIE_NAME]) {
      setCsrfCookie(res, generateCsrfToken(), authConfig.secureCookie);
    }
    next();
    return;
  }
  res.status(401).json({ error: "Not authenticated" });
}
