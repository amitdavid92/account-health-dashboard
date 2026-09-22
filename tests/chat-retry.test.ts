import { test } from "node:test";
import assert from "node:assert/strict";
import { withChatRetry } from "../src/lib/chat-retry";

test("recovers from two transient failures", async () => {
  let calls = 0;
  const result = await withChatRetry(async () => {
    if (++calls < 3) throw { status: 503 };
    return "answer";
  }, new AbortController().signal, { remaining: 2 }, 0);
  assert.equal(result, "answer");
  assert.equal(calls, 3);
});

test("shares retry budget between tool rounds", async () => {
  const budget = { remaining: 2 };
  let calls = 0;
  const fail = async () => { calls++; throw { status: 429 }; };
  await assert.rejects(withChatRetry(fail, new AbortController().signal, budget, 0));
  await assert.rejects(withChatRetry(fail, new AbortController().signal, budget, 0));
  assert.equal(calls, 4);
});

test("does not retry rejected credentials", async () => {
  let calls = 0;
  await assert.rejects(withChatRetry(async () => { calls++; throw { status: 403 }; },
    new AbortController().signal, { remaining: 2 }, 0));
  assert.equal(calls, 1);
});

test("deadline stops a stalled provider call", async () => {
  const controller = new AbortController();
  const result = withChatRetry(() => new Promise(() => {}), controller.signal, { remaining: 2 });
  controller.abort(new Error("deadline"));
  await assert.rejects(result, /deadline/);
});

test("cancellation stops waiting before a retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = withChatRetry(async () => { calls++; throw { status: 503 }; }, controller.signal, { remaining: 2 });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(result);
  assert.equal(calls, 1);
});
