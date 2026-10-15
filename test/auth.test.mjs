// Tests for the auth module's two modes. Run against the compiled output
// (`npm test` builds first), and kept out of src/ so nothing here is published
// in `build/`.
//
// The module holds its config in a single mutable singleton that configureAuth
// replaces WHOLESALE, so these tests configure it explicitly at the top of each
// case rather than relying on module-level defaults carrying over — test order
// would otherwise decide the result.
//
// The case that matters most is "omitting enabled keeps auth on": `enabled` is
// read as `=== false`, so a caller that forgets it must fail CLOSED. Falsiness
// there would open the feed on the deployment that most needs the gate, and a
// .mjs test is not type-checked, so nothing but this test would catch it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configureAuth,
  requireAuth,
  requireCsrfToken,
  loginHandler,
  sessionStatusHandler,
} from "../build/auth.js";

const PASSWORD = "correct-horse-battery";
const SECRET = "s".repeat(48);
const CSRF_COOKIE = "pulse_csrf";

/** Minimal Express response stub, recording what the handler did to it. */
function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    cookies: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    cookie(name, value, options) {
      res.cookies[name] = { value, options };
      return res;
    },
    clearCookie(name) {
      delete res.cookies[name];
      return res;
    },
  };
  return res;
}

function mockReq({ cookie, method = "GET", headers = {}, body } = {}) {
  return {
    method,
    body,
    ip: "203.0.113.7",
    socket: { remoteAddress: "203.0.113.7" },
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  };
}

/** Runs a middleware and reports whether it called next(). */
function run(middleware, req, res) {
  let passed = false;
  middleware(req, res, () => {
    passed = true;
  });
  return passed;
}

test("disabled: requireAuth passes through and issues the CSRF cookie", () => {
  configureAuth({ enabled: false, appPassword: "", sessionSecret: "", secureCookie: true });
  const res = mockRes();

  const passed = run(requireAuth, mockReq(), res);

  assert.equal(passed, true, "request should reach the handler with no session cookie");
  assert.equal(res.statusCode, 200, "should not have been rejected");
  // The client loads /api/lists before it can POST anything, so this request is
  // what seeds the cookie requireCsrfToken later demands.
  assert.ok(res.cookies[CSRF_COOKIE], "should have issued a CSRF cookie");
  assert.equal(res.cookies[CSRF_COOKIE].options.httpOnly, false);
});

test("disabled: requireAuth does not reissue an existing CSRF cookie", () => {
  configureAuth({ enabled: false, appPassword: "", sessionSecret: "", secureCookie: true });
  const res = mockRes();

  run(requireAuth, mockReq({ cookie: `${CSRF_COOKIE}=already-set` }), res);

  assert.equal(res.cookies[CSRF_COOKIE], undefined, "should have left the existing cookie alone");
});

test("disabled: session reports authenticated so the login screen never renders", () => {
  configureAuth({ enabled: false, appPassword: "", sessionSecret: "", secureCookie: true });
  const res = mockRes();

  sessionStatusHandler(mockReq(), res);

  assert.equal(res.body.authenticated, true);
  assert.equal(res.body.authEnabled, false);
});

test("disabled: login is closed", () => {
  configureAuth({ enabled: false, appPassword: "", sessionSecret: "", secureCookie: true });
  const res = mockRes();

  loginHandler(mockReq({ method: "POST", body: { password: PASSWORD } }), res);

  assert.equal(res.statusCode, 404, "no session to mint, so the route should not exist");
  assert.equal(res.cookies.pulse_session, undefined);
});

test("enabled: requireAuth rejects a request with no session", () => {
  configureAuth({ enabled: true, appPassword: PASSWORD, sessionSecret: SECRET, secureCookie: true });
  const res = mockRes();

  const passed = run(requireAuth, mockReq(), res);

  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});

test("enabled: session reports unauthenticated and authEnabled", () => {
  configureAuth({ enabled: true, appPassword: PASSWORD, sessionSecret: SECRET, secureCookie: true });
  const res = mockRes();

  sessionStatusHandler(mockReq(), res);

  assert.equal(res.body.authenticated, false);
  assert.equal(res.body.authEnabled, true);
});

// The fail-open regression guard: configureAuth replaces the config object
// wholesale, so a caller that omits `enabled` leaves it undefined. Auth must
// stay ON.
test("enabled: omitting `enabled` from configureAuth keeps auth ON", () => {
  configureAuth({ appPassword: PASSWORD, sessionSecret: SECRET, secureCookie: true });
  const res = mockRes();

  const passed = run(requireAuth, mockReq(), res);

  assert.equal(passed, false, "a missing `enabled` must not open the feed");
  assert.equal(res.statusCode, 401);
});

test("requireCsrfToken rejects a cookie with no matching header", () => {
  configureAuth({ enabled: false, appPassword: "", sessionSecret: "", secureCookie: true });
  const res = mockRes();

  const passed = run(
    requireCsrfToken,
    mockReq({ method: "POST", cookie: `${CSRF_COOKIE}=abc123` }),
    res
  );

  assert.equal(passed, false, "the cookie alone is not proof — the header must match");
  assert.equal(res.statusCode, 403);
});

test("requireCsrfToken accepts a matching cookie and header", () => {
  configureAuth({ enabled: false, appPassword: "", sessionSecret: "", secureCookie: true });
  const res = mockRes();

  const passed = run(
    requireCsrfToken,
    mockReq({
      method: "POST",
      cookie: `${CSRF_COOKIE}=abc123`,
      headers: { "x-csrf-token": "abc123" },
    }),
    res
  );

  assert.equal(passed, true);
});

test("requireCsrfToken lets safe methods through without a token", () => {
  configureAuth({ enabled: true, appPassword: PASSWORD, sessionSecret: SECRET, secureCookie: true });
  const res = mockRes();

  assert.equal(run(requireCsrfToken, mockReq({ method: "GET" }), res), true);
  assert.equal(run(requireCsrfToken, mockReq({ method: "HEAD" }), res), true);
  assert.equal(run(requireCsrfToken, mockReq({ method: "OPTIONS" }), res), true);
});
