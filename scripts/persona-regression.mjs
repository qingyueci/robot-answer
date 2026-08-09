import assert from "node:assert/strict";
import { detectConversationMode, modeInstruction } from "../apps/web/src/lib/chat/mode.ts";
import { ROBOT_SYSTEM_PROMPT } from "../apps/web/src/lib/persona/system-prompt.ts";
import { ROBOT_INTERACTION_PROFILE } from "../apps/web/src/lib/persona/interaction-profile.ts";
import {
  VOICE_EXAMPLE_COUNT,
  voiceExamplesForMode,
} from "../apps/web/src/lib/persona/voice-examples.ts";
import {
  AUTO_TOPIC_DELAY_MS,
  emotionExpiresAt,
  followUpMessage,
  isFollowUpQuietHours,
  shouldScheduleAutoTopic,
} from "../apps/web/src/lib/companion/state-policy.ts";
import {
  compactJournalText,
  detectJournalTheme,
  isTrivialUserTurn,
  looksContradictory,
  mergeDistinctText,
  textSimilarity,
} from "../apps/web/src/lib/governance/text.ts";

const modeCases = [
  ["今天真的很累，先别给我计划。", "emotional"],
  ["你觉得我该不该辞职", "advice"],
  ["帮我分析一下最近为什么总拖延", "analysis"],
  ["什么是情绪内耗", "factual"],
  ["今晚有点想你了", "intimate"],
  ["吃饭", "casual"],
];

for (const [text, expected] of modeCases) {
  assert.equal(
    detectConversationMode(text),
    expected,
    `“${text}”应识别为 ${expected}`,
  );
}

assert.equal(
  detectConversationMode("还是难受", ["今天真的很累"]),
  "emotional",
  "短句应延续最近的情绪语境",
);

for (const mode of ["casual", "intimate", "emotional", "advice", "analysis", "factual"]) {
  assert.match(modeInstruction(mode), /当前会话模式/);
  assert.match(voiceExamplesForMode(mode), /语气锚点/);
}

for (const required of [
  "不像客服、心理咨询师",
  "大多数回复不以问题结尾",
  "用户说你生硬、没接住或情感太淡时",
  "默认情感浓度偏高",
  "精选语气示例是表达锚点",
]) {
  assert.ok(
    ROBOT_SYSTEM_PROMPT.includes(required),
    `人格提示缺少关键约束：${required}`,
  );
}

assert.equal(
  isFollowUpQuietHours(new Date(2026, 6, 31, 23, 30)),
  true,
  "23:30 后应处于免打扰",
);
assert.equal(
  isFollowUpQuietHours(new Date(2026, 6, 31, 9, 0)),
  false,
  "09:00 后可以轻量回访",
);
assert.match(
  followUpMessage("观棋正在整理个人知识库。", 1),
  /整理个人知识库/,
);
assert.equal(
  Date.parse(emotionExpiresAt(new Date("2026-07-31T00:00:00.000Z"))) -
    Date.parse("2026-07-31T00:00:00.000Z"),
  12 * 60 * 60 * 1000,
  "轻量情绪应在 12 小时后过期",
);
assert.equal(AUTO_TOPIC_DELAY_MS, 45_000);
assert.equal(
  shouldScheduleAutoTopic("这个问题清楚了", "好，那先到这里。"),
  true,
  "话题自然收束后应准备切换新话题",
);
assert.equal(
  shouldScheduleAutoTopic("我再想想", "你更在意成本还是时间？"),
  false,
  "当前话题仍有待回答问题时不应切换",
);
assert.equal(
  shouldScheduleAutoTopic("我先去忙了", "好，忙完再说。"),
  false,
  "用户准备离开时不应继续开新话题",
);

for (const required of [
  "低置信度线索",
  "低成本、可逆的小选择",
  "当前专属称呼仍待验证",
  "不反复引用“行动力差”",
  "当前话题自然收束",
  "24 小时未回复",
  "偏暧昧、情感浓烈",
]) {
  assert.ok(
    ROBOT_INTERACTION_PROFILE.includes(required),
    `交互素材缺少关键约束：${required}`,
  );
}

assert.equal(VOICE_EXAMPLE_COUNT, 24, "六类场景应各有四条精选语气示例");

assert.ok(
  textSimilarity("你正在考虑点外卖还是自己做云吞", "你尚未决定吃外卖还是煮云吞") >=
    0.68,
  "相似的未完成话题应能被识别",
);
assert.equal(
  mergeDistinctText("你决定开始读《道德经》", "你决定开始读《道德经》。今天先读第一章"),
  "你决定开始读《道德经》；今天先读第一章",
  "日记合并应去掉重复句并保留新增信息",
);
assert.equal(isTrivialUserTurn("嗯嗯"), true);
assert.equal(isTrivialUserTurn("你刚才说得太生硬了"), false);
assert.equal(
  looksContradictory("你偏好简洁的回答", "你希望回答更详细展开"),
  true,
);
assert.equal(
  detectJournalTheme("推荐陈鼓应《老子注译及评介》", "今天开始读"),
  "classics",
);
assert.equal(
  compactJournalText("第一句；第二句；第三句；第四句；第五句"),
  "第一句；第二句；第三句；第四句",
);

console.log(
  `回归通过：${modeCases.length + 1} 个模式样例，5 条语气约束，7 条交互素材约束，24 条语气示例，7 条回访/情绪约束，7 条治理规则。`,
);
