// Tests for the LLM retry predicate. Kept out of src/ so nothing here is
// published in `build/`, and run against the compiled output (`npm test` builds
// first).
//
// The predicate exists to stop retrying failures that cannot succeed on a
// second attempt. A retry costs a full round trip against the same quota, so
// the expensive mistake is a false positive, not a false negative — hence the
// "unknown errors fail closed" cases at the bottom.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmHttpError, isRetryableLlmError } from "../build/summarizer.js";

test("transport-shaped HTTP failures are retried", () => {
  for (const status of [408, 500, 502, 503, 504, 529]) {
    assert.equal(isRetryableLlmError(new LlmHttpError("OpenAI", status, "body")), true, `OpenAI ${status}`);
    assert.equal(isRetryableLlmError(new LlmHttpError("Gemini", status, "body")), true, `Gemini ${status}`);
  }
});

test("client errors are not retried", () => {
  // 400 bad request, 401 bad key, 403 forbidden, 404 unknown model, 413 too
  // large, 422 bad schema: all deterministic, and a second call fails the same
  // way while spending another round trip.
  for (const status of [400, 401, 403, 404, 413, 422]) {
    assert.equal(isRetryableLlmError(new LlmHttpError("Gemini", status, "body")), false, `Gemini ${status}`);
  }
});

test("429 is not retried", () => {
  // Rate-limit / quota-exceeded. The retry was immediate and unbounded, so it
  // burned quota again at the exact moment quota was the problem. The next
  // scheduled cycle is the natural backoff.
  assert.equal(isRetryableLlmError(new LlmHttpError("Gemini", 429, "quota exceeded")), false);
});

test("501 is not retried even though it is a 5xx", () => {
  // "Not implemented" is a permanent property of the endpoint, not a blip.
  assert.equal(isRetryableLlmError(new LlmHttpError("OpenAI", 501, "not implemented")), false);
  assert.equal(isRetryableLlmError(new LlmHttpError("OpenAI", 502, "bad gateway")), true);
});

test("timeouts and network failures are retried", () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError"; // AbortSignal.timeout
  assert.equal(isRetryableLlmError(timeout), true);
  assert.equal(isRetryableLlmError(new TypeError("fetch failed")), true); // undici
});

test("anything unrecognised fails closed", () => {
  // A TypeError from our own code is a bug, not a network blip; retrying it
  // just doubles the noise. Only undici's exact "fetch failed" counts.
  const cases = [
    new TypeError("x is undefined"),
    new SyntaxError("Unexpected token < in JSON"),
    new RangeError("Invalid array length"),
    new Error("boom"),
    Object.assign(new Error("timed out"), { name: "AbortError" }),
    "Gemini API error: 503",
    { status: 503 },
    undefined,
    null,
  ];
  for (const error of cases) {
    assert.equal(isRetryableLlmError(error), false, `${String(error)} should not be retried`);
  }
});

test("the error message keeps the prefix the client sanitizer matches on", () => {
  // scheduler.ts's sanitizeErrorForClient strips LLM response bodies out of
  // user-facing errors by matching this exact prefix. LlmHttpError replaced a
  // plain `new Error(...)`, so the wording has to survive.
  const error = new LlmHttpError("Gemini", 503, "upstream unavailable");
  assert.ok(error.message.startsWith("Gemini API error: 503"), error.message);
  assert.equal(error.provider, "Gemini");
  assert.equal(error.status, 503);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "LlmHttpError");
});
