import assert from "node:assert/strict";
import {
  rankRecallCandidates,
  RECALL_ROUTES,
} from "../apps/web/src/lib/memory/recall-ranking.ts";
import {
  buildExplicitGroundedMemoryReply,
  buildMemoryGroundingSection,
  evidenceForMemory,
} from "../apps/web/src/lib/memory/grounding.ts";
import {
  conflictsWithCurrentFactCorrection,
  extractCurrentFactCorrection,
  reflectsCurrentFactCorrection,
} from "../apps/web/src/lib/governance/text.ts";

const now = new Date().toISOString();
const query = "我最近想继续聊做对话机器人和记忆系统";
const confirmedEvidence = {
  evidenceKind: "user_statement",
  assertionMode: "fact",
  confidence: 0.9,
  memoryType: "stable_fact",
  source: "conversation:test",
};
const candidates = [
  {
    id: "k1",
    content: "用户偏好直接、技术同事式的沟通",
    route: "keyword",
    sourceType: "memory:ordinary_preference",
    ...confirmedEvidence,
    assertionMode: "qualified",
    memoryType: "ordinary_preference",
    baseScore: 0.52,
    reliability: 1,
    routeRank: 1,
    updatedAt: now,
  },
  {
    id: "s1",
    content: "用户正在开发带长期记忆的对话机器人",
    route: "semantic",
    sourceType: "mem0",
    ...confirmedEvidence,
    assertionMode: "qualified",
    baseScore: 0.91,
    reliability: 1,
    routeRank: 1,
    updatedAt: now,
  },
  {
    id: "t1",
    content: "今天讨论了对话机器人的记忆系统",
    route: "temporal",
    sourceType: "journal",
    ...confirmedEvidence,
    evidenceKind: "derived_summary",
    assertionMode: "qualified",
    memoryType: "journal",
    baseScore: 0.84,
    reliability: 0.9,
    routeRank: 1,
    updatedAt: now,
  },
  {
    id: "p1",
    content: "仍可接续的话题：完善机器人的五路记忆召回",
    route: "topic",
    sourceType: "open-topic",
    ...confirmedEvidence,
    evidenceKind: "topic_state",
    assertionMode: "context_only",
    memoryType: "open_topic",
    baseScore: 0.88,
    reliability: 0.82,
    routeRank: 1,
    updatedAt: now,
  },
  {
    id: "r1",
    content: "最近一次用户提到：想把机器人做到更自然的对话级别",
    route: "relationship",
    sourceType: "relationship-state",
    ...confirmedEvidence,
    evidenceKind: "derived_summary",
    assertionMode: "qualified",
    memoryType: "relationship_state",
    baseScore: 0.7,
    reliability: 0.78,
    routeRank: 1,
    updatedAt: now,
  },
  {
    id: "duplicate",
    content: "用户正开发一个拥有长期记忆的对话机器人",
    route: "keyword",
    sourceType: "memory:stable_fact",
    ...confirmedEvidence,
    baseScore: 0.86,
    reliability: 1,
    routeRank: 2,
    updatedAt: now,
  },
];

const result = rankRecallCandidates(query, candidates, 6);
assert.ok(result.length >= 4, "统一排序不应丢掉大部分有效候选");
assert.equal(
  result.filter((item) => item.id === "s1" || item.id === "duplicate").length,
  1,
  "跨路重复记忆应合并为一条",
);
assert.ok(
  RECALL_ROUTES.every((route) =>
    candidates.some((candidate) => candidate.route === route),
  ),
  "回归夹具必须覆盖五路召回",
);
assert.ok(
  result.every((item, index) => index === 0 || result[index - 1].score >= item.score),
  "结果必须按统一分数降序排列",
);

const mergedMemory = result.find(
  (item) => item.id === "s1" || item.id === "duplicate",
);
assert.equal(
  mergedMemory?.id,
  "duplicate",
  "跨路重复时应保留断言更可靠的本地事实证据，而非只取较高向量分数",
);

const strongFact = {
  id: "strong-fact",
  content: "用户前几天发烧不舒服",
  route: "keyword",
  sourceType: "memory:sensitive",
  evidenceKind: "user_statement",
  assertionMode: "fact",
  confidence: 0.86,
  memoryType: "sensitive",
  source: "conversation:fever",
  baseScore: 0.55,
  reliability: 0.86,
  routeRank: 2,
  updatedAt: now,
};
const verboseInference = {
  id: "verbose-inference",
  content: "用户前几天发烧不舒服，声音嘶哑并且整天躺在床上",
  route: "semantic",
  sourceType: "mem0",
  evidenceKind: "model_inference",
  assertionMode: "qualified",
  confidence: 0.65,
  memoryType: "personality_inference",
  source: "mem0:stale",
  baseScore: 1,
  reliability: 0.65,
  routeRank: 1,
  updatedAt: now,
};
const groundedDuplicate = rankRecallCandidates(
  "之前发烧不舒服",
  [verboseInference, strongFact],
  2,
)[0];
assert.equal(groundedDuplicate.id, strongFact.id);
assert.equal(
  groundedDuplicate.content,
  strongFact.content,
  "较强证据替换较弱候选时，正文必须同步替换，不能把推断细节标成事实",
);

const grounding = buildMemoryGroundingSection([
  {
    content: "用户前几天身体不舒服",
    evidenceKind: "user_statement",
    assertionMode: "fact",
    confidence: 0.86,
    reliability: 0.86,
    memoryType: "sensitive",
    source: "conversation:fever-test",
    updatedAt: now,
  },
  {
    content: "用户可能习惯独自消化压力",
    evidenceKind: "model_inference",
    assertionMode: "qualified",
    confidence: 0.62,
    reliability: 0.62,
    memoryType: "personality_inference",
    source: "local-memory:inference-test",
    updatedAt: now,
  },
]);
for (const field of [
  "assertion=fact",
  "evidence=user_statement",
  "memory_type=sensitive",
  "confidence=0.86",
  "source=conversation:fever-test",
  `time=${now}`,
]) {
  assert.ok(grounding.includes(field), `Grounding Prompt 必须包含 ${field}`);
}
assert.match(
  grounding,
  /不得补出证据中没有的症状、地点、具体时间、动作、对话、动机或结果/,
  "Grounding Prompt 必须明确禁止补写共同经历细节",
);
assert.match(
  grounding,
  /历史事实和当前推测必须分开表达/,
  "Grounding Prompt 必须分开事实与推测",
);
assert.match(
  grounding,
  /用户曾表述；不是你的亲历/,
  "用户说过某事不等于 Robot 亲历了现场",
);
assert.match(
  grounding,
  /只能说“我记得你提过……”.*不能说“你当时的样子我印象很深”/,
  "Grounding Prompt 必须禁止把用户陈述扩写成共同经历",
);
assert.match(
  grounding,
  /亲切、自然或亲密都不是扩写证据的理由/,
  "亲密感不能覆盖证据边界",
);
assert.match(
  grounding,
  /evidence=model_inference/,
  "性格推断必须带明确的推断标记",
);
assert.match(
  grounding,
  /evidence=model_inference 永远不是记忆事实/,
  "模型推断必须被禁止伪装成记得的事实",
);

const manualEvidence = evidenceForMemory({
  id: "manual",
  category: "stable_fact",
  confidence: 1,
  sourceConversationId: null,
  sourceExcerpt: "用户直接提供并确认的长期记忆素材",
});
assert.equal(manualEvidence.evidenceKind, "user_confirmed");
assert.equal(manualEvidence.assertionMode, "fact");

const inferredEvidence = evidenceForMemory({
  id: "inference",
  category: "personality_inference",
  confidence: 0.98,
  sourceConversationId: "conversation-1",
  sourceExcerpt: "",
});
assert.equal(inferredEvidence.evidenceKind, "model_inference");
assert.equal(
  inferredEvidence.assertionMode,
  "qualified",
  "高置信度性格推断也不能升级为历史事实",
);

const explicitReply = buildExplicitGroundedMemoryReply(
  "你还记得我之前发烧吗？",
  [
    {
      content: "用户前几天发烧，身体不舒服。",
      evidenceKind: "user_statement",
      assertionMode: "fact",
      confidence: 0.88,
      reliability: 0.88,
      memoryType: "sensitive",
      source: "conversation:fever-test",
      updatedAt: now,
    },
  ],
);
assert.match(explicitReply ?? "", /记得你提过：你前几天发烧，身体不舒服/);
assert.match(explicitReply ?? "", /没有足够依据，不往下补/);
assert.doesNotMatch(explicitReply ?? "", /声音|嗓子|躺在床|嘴硬/);
assert.equal(
  buildExplicitGroundedMemoryReply("今天练了侧方停车。", []),
  null,
  "受控记忆回复只接管明确的记忆询问，不影响普通聊天",
);
assert.match(
  buildExplicitGroundedMemoryReply("你还记得这件事吗？", []) ?? "",
  /没有足够明确的记忆/,
  "没有证据时应明确不补细节",
);

const correctionText = "你还记得吗？我之前不是发烧，是食物中毒。";
const correction = extractCurrentFactCorrection(correctionText);
assert.deepEqual(correction, {
  scope: "我之前",
  rejected: "发烧",
  asserted: "食物中毒",
});
assert.equal(
  conflictsWithCurrentFactCorrection(
    "用户之前发烧，身体不舒服",
    correctionText,
  ),
  true,
  "旧记忆命中本轮明确否定的事实时必须判为冲突",
);
assert.equal(
  reflectsCurrentFactCorrection(
    "用户之前其实是食物中毒，不是发烧",
    correctionText,
  ),
  true,
  "后台提取出的新事实必须识别为本轮纠正内容",
);
const correctedReply = buildExplicitGroundedMemoryReply(
  correctionText,
  [
    {
      content: "用户之前发烧，身体不舒服",
      evidenceKind: "user_statement",
      assertionMode: "fact",
      confidence: 0.88,
      reliability: 0.88,
      memoryType: "sensitive",
      source: "conversation:old-fever",
      updatedAt: now,
    },
  ],
  correction,
);
assert.match(correctedReply ?? "", /以“食物中毒”为准/);
assert.doesNotMatch(
  correctedReply ?? "",
  /记得你提过.*发烧/,
  "显式记忆静态分支不得把本轮已否定的旧事实再次确认",
);

const ordinaryCorrectionText = "我之前不是发烧，是食物中毒。";
assert.equal(
  buildExplicitGroundedMemoryReply(ordinaryCorrectionText, [strongFact]),
  null,
  "普通事实纠正不应误触发显式记忆静态回复",
);
const ordinaryTurnRecall = [strongFact].filter(
  (item) =>
    !conflictsWithCurrentFactCorrection(item.content, ordinaryCorrectionText),
);
const ordinaryTurnGrounding = buildMemoryGroundingSection(ordinaryTurnRecall);
assert.equal(ordinaryTurnRecall.length, 0);
assert.doesNotMatch(
  ordinaryTurnGrounding,
  /用户前几天发烧不舒服/,
  "普通纠正轮也必须在最终 Grounding Prompt 前移除被否定的旧事实",
);
assert.match(ordinaryTurnGrounding, /本轮没有可用的历史证据/);

const scopedCorrection = "我住的地方不是上海，而是北京。";
assert.deepEqual(extractCurrentFactCorrection(scopedCorrection), {
  scope: "我住的地方",
  rejected: "上海",
  asserted: "北京",
});
assert.equal(
  conflictsWithCurrentFactCorrection("用户喜欢上海菜", scopedCorrection),
  false,
  "同词但不同作用域的事实不得被纠正淘汰",
);
assert.equal(
  conflictsWithCurrentFactCorrection("用户住在上海", scopedCorrection),
  true,
  "纠正作用域匹配时才停用旧事实",
);

const vagueReply = buildExplicitGroundedMemoryReply(
  "你还记得吗？",
  [
    {
      content: "用户偏好黑咖啡",
      evidenceKind: "user_statement",
      assertionMode: "qualified",
      confidence: 0.82,
      reliability: 0.82,
      memoryType: "ordinary_preference",
      source: "conversation:unrelated",
      updatedAt: now,
    },
  ],
);
assert.match(vagueReply ?? "", /没有指向具体哪件事/);
assert.doesNotMatch(
  vagueReply ?? "",
  /黑咖啡/,
  "无主题的显式记忆问题不得随机采用低相关旧记忆",
);

console.log(
  JSON.stringify({
    ok: true,
    routes: RECALL_ROUTES,
    selected: result.map((item) => ({
      id: item.id,
      score: Number(item.score.toFixed(4)),
      routes: item.routes,
    })),
  }),
);
