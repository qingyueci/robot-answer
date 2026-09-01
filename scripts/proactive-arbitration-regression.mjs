import assert from "node:assert/strict";
import { convertToModelMessages } from "ai";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTO_TOPIC_DELAY_MS,
  canSendProactiveCandidate,
  isProactiveCandidateFresh,
  isMeaninglessMomentText,
  postTurnThreadState,
  readPersistedRobotPolicy,
  shouldScheduleAutoTopic,
  withPersistedRobotPolicy,
} from "../apps/web/src/lib/companion/state-policy.ts";

const stable = {
  candidateEpoch: 7,
  currentEpoch: 7,
  candidateConversationId: "conversation-a",
  currentConversationId: "conversation-a",
  basedOnMessageId: "assistant-1",
  latestMessageId: "assistant-1",
  inputEmpty: true,
  visible: true,
  busy: false,
  threadState: "settled",
};

assert.equal(AUTO_TOPIC_DELAY_MS, 30 * 60 * 1000, "普通主动换题应等待 30 分钟 idle");
assert.equal(isMeaninglessMomentText("嗯"), true, "显式 ACK 不应覆盖 lastMoment");
assert.equal(isMeaninglessMomentText("有点累"), false, "短句中的真实状态应保留");
assert.equal(canSendProactiveCandidate(stable), true, "状态完全未变时候选才可发送");
assert.equal(
  canSendProactiveCandidate({
    ...stable,
    threadState: "active",
    allowActiveAfterIdle: true,
  }),
  true,
  "真实 idle 到期后，历史 active 只允许进入后续仲裁，不应永久封锁",
);
assert.equal(
  isProactiveCandidateFresh(
    "2026-08-11T02:00:00.000Z",
    new Date("2026-08-11T02:01:59.000Z"),
  ),
  true,
  "两分钟内的候选仍可进入 Send Gate",
);
assert.equal(
  isProactiveCandidateFresh(
    "2026-08-11T02:00:00.000Z",
    new Date("2026-08-11T02:02:01.000Z"),
  ),
  false,
  "超过两分钟的候选应过期",
);

for (const [name, changed] of [
  ["用户输入推进 activity epoch", { currentEpoch: 8 }],
  ["用户新消息改变 latest message", { latestMessageId: "user-2" }],
  ["用户切换会话", { currentConversationId: "conversation-b" }],
  ["输入框已有内容", { inputEmpty: false }],
  ["页面不可见", { visible: false }],
  ["主回复正在生成", { busy: true }],
  ["当前 thread 活跃", { threadState: "active" }],
  ["用户准备离开", { threadState: "departing" }],
]) {
  assert.equal(
    canSendProactiveCandidate({ ...stable, ...changed }),
    false,
    `${name}时应丢弃候选`,
  );
}

assert.equal(
  shouldScheduleAutoTopic("我还想继续聊这个", "我也觉得这里值得再展开。", "active"),
  true,
  "active thread 应启动 idle timer，30 分钟内仍不会生成候选",
);
assert.equal(
  shouldScheduleAutoTopic("我还在想", "你最在意的是哪一层？", "active"),
  true,
  "active thread 即使留有问题，也应在真实 idle 后进入模型仲裁",
);
assert.equal(
  postTurnThreadState({
    declaredState: "active",
    conversationMove: "answer",
    assistantText: "侧方停车主要看点位、车速和方向盘时机。",
    hasDeepReasoning: false,
  }),
  "open",
  "普通问题被完整回答后，应允许从 pre-generation active 降为 open",
);
assert.equal(
  postTurnThreadState({
    declaredState: "active",
    conversationMove: "answer",
    assistantText: "真相与自主权之间还需要继续辨析。",
    hasDeepReasoning: true,
  }),
  "active",
  "深度推理回复仍应维持 active thread",
);
assert.equal(
  postTurnThreadState({
    declaredState: "active",
    conversationMove: "continue_thread",
    assistantText: "这里还有一层值得接着说。",
    hasDeepReasoning: false,
  }),
  "active",
  "continue_thread 不应被误判为已完成回答",
);
assert.equal(
  shouldScheduleAutoTopic("这个问题清楚了", "好，那先到这里。", "settled"),
  true,
  "自然收束后保留主动开新话题能力",
);

const messageWithMetadata = {
  id: "assistant-policy",
  role: "assistant",
  metadata: {
    threadState: "active",
    conversationMove: "continue_thread",
    bubbleLayout: "single",
  },
  parts: [{ type: "text", text: "这里还有一层值得接着说。" }],
};
const persistedMessage = withPersistedRobotPolicy(messageWithMetadata);
const reloadedMessage = {
  id: persistedMessage.id,
  role: persistedMessage.role,
  parts: JSON.parse(JSON.stringify(persistedMessage.parts)),
};
assert.deepEqual(readPersistedRobotPolicy(reloadedMessage), {
  threadState: "active",
  conversationMove: "continue_thread",
  bubbleLayout: "single",
});
assert.equal(
  persistedMessage.parts.filter((part) => part.type === "data-robot-policy").length,
  1,
  "策略状态应以单个 AI SDK data part 随现有 parts JSON 持久化",
);
assert.equal(
  withPersistedRobotPolicy(persistedMessage).parts.filter(
    (part) => part.type === "data-robot-policy",
  ).length,
  1,
  "重复保存同一消息时不得累积策略 data part",
);
const convertedPolicyMessage = await convertToModelMessages([reloadedMessage]);
assert.doesNotMatch(
  JSON.stringify(convertedPolicyMessage),
  /robot-policy/,
  "AI SDK 应忽略未配置 convertDataPart 的本地策略数据，不能把它发送给模型",
);

const pageSource = readFileSync(
  new URL("../apps/web/src/app/page.tsx", import.meta.url),
  "utf8",
);
const submitSource = pageSource.slice(
  pageSource.indexOf("async function submit()"),
  pageSource.indexOf("async function startNewConversation()"),
);
const registerIndex = submitSource.indexOf("await registerServerActivity()");
const persistIndex = submitSource.indexOf("await saveChatMessage(");
assert.ok(registerIndex >= 0, "submit 必须预登记服务端活动");
assert.ok(
  persistIndex > registerIndex,
  "服务端活动预登记必须发生在用户消息持久化之前",
);
const openSessionSource = pageSource.slice(
  pageSource.indexOf("openChatSession()"),
  pageSource.indexOf("bottomRef.current?.scrollIntoView"),
);
assert.match(
  openSessionSource,
  /mode:\s*"auto-topic"/,
  "页面重开后也必须允许 30 分钟真实 idle 的历史 thread 进入模型仲裁",
);

const integrationDb = path.join(
  tmpdir(),
  `robot-proactive-activity-${randomUUID()}.db`,
);
const workerPath = fileURLToPath(
  new URL("./proactive-activity-route-worker.mjs", import.meta.url),
);
let integration;
try {
  integration = spawnSync(process.execPath, ["--no-warnings", workerPath], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    encoding: "utf8",
    env: { ...process.env, ROBOT_STATE_DB_PATH: integrationDb },
  });
} finally {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`${integrationDb}${suffix}`, { force: true });
  }
}
assert.equal(
  integration.status,
  0,
  `activity route 集成失败：${integration.stderr || integration.stdout}`,
);

console.log("主动消息仲裁回归通过：含跨标签广播、activity 预登记顺序与服务端路由集成。");
