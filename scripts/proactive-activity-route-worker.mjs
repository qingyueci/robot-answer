import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const unresolved = specifier.startsWith("@/")
      ? path.resolve(process.cwd(), "apps/web/src", specifier.slice(2))
      : specifier.startsWith(".") && context.parentURL?.startsWith("file:")
        ? path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
        : null;
    if (!unresolved) return nextResolve(specifier, context);
    const resolved = [
      `${unresolved}.ts`,
      `${unresolved}.tsx`,
      path.join(unresolved, "index.ts"),
    ].find(existsSync);
    if (!resolved) return nextResolve(specifier, context);
    return { shortCircuit: true, url: pathToFileURL(resolved).href };
  },
});

const route = await import("../apps/web/src/app/api/follow-up/route.ts");
const store = await import("../apps/web/src/lib/companion/store.ts");

assert.equal(store.getRelationshipState().lastInteractionAt, null);
const activityResponse = await route.POST(
  new Request("http://local.test/api/follow-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "activity" }),
  }),
);
const activity = await activityResponse.json();
assert.equal(activity.ok, true, "activity mode 应成功登记服务端活动");
assert.equal(
  store.getRelationshipState().lastInteractionAt,
  activity.activityAt,
  "activity mode 必须立即更新共享 last_interaction_at",
);

const candidate = {
  kind: "auto-topic",
  topicId: null,
  topicUpdatedAt: null,
  topicFollowUpCount: null,
  text: "旧候选",
  generatedAt: new Date(Date.parse(activity.activityAt) - 1).toISOString(),
  conversationId: "conversation-a",
  basedOnMessageId: "assistant-a",
};
const validationResponse = await route.POST(
  new Request("http://local.test/api/follow-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "validate",
      threadState: "settled",
      candidate,
    }),
  }),
);
const validation = await validationResponse.json();
assert.deepEqual(
  validation,
  { valid: false, reason: "user_active" },
  "活动预登记后，旧候选必须由服务端作废",
);

store.touchUserActivity(new Date(Date.now() - 5 * 60 * 1000));
const recentActiveCandidate = {
  ...candidate,
  generatedAt: new Date().toISOString(),
};
const recentActiveResponse = await route.POST(
  new Request("http://local.test/api/follow-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "validate",
      threadState: "active",
      candidate: recentActiveCandidate,
    }),
  }),
);
assert.deepEqual(
  await recentActiveResponse.json(),
  { valid: false, reason: "thread_recent" },
  "最近 30 分钟仍活跃的 thread 必须继续阻止主动候选",
);

store.touchUserActivity(new Date(Date.now() - 31 * 60 * 1000));
const idleActiveCandidate = {
  ...candidate,
  generatedAt: new Date().toISOString(),
};
const idleActiveResponse = await route.POST(
  new Request("http://local.test/api/follow-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "validate",
      threadState: "active",
      candidate: idleActiveCandidate,
    }),
  }),
);
assert.deepEqual(
  await idleActiveResponse.json(),
  { valid: true, reason: null },
  "active thread 超过 30 分钟真实 idle 后应获准进入最终仲裁",
);

console.log("activity route integration passed");
