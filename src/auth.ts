import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";

const SESSION_COOKIE_NAME = "pulse_session";
const CSRF_COOKIE_NAME = "pulse_csrf";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Injected once by startTerminal — the core never reads these from the env.
let authConfig = { appPassword: "", sessionSecret: "", secureCookie: false };

export function configureAuth(config: { appPassword: string; sessionSecret: string; secureCookie: boolean }): void {
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
  const cookies = parseCookies(req.headers.cookie);
  res.json({ authenticated: isValidSessionValue(cookies[SESSION_COOKIE_NAME]) });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
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
