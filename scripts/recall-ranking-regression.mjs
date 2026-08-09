import assert from "node:assert/strict";
import {
  rankRecallCandidates,
  RECALL_ROUTES,
} from "../apps/web/src/lib/memory/recall-ranking.ts";

const now = new Date().toISOString();
const query = "我最近想继续聊做对话机器人和记忆系统";
const candidates = [
  {
    id: "k1",
    content: "用户偏好直接、技术同事式的沟通",
    route: "keyword",
    sourceType: "memory:ordinary_preference",
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
