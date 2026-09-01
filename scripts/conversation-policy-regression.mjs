import assert from "node:assert/strict";
import {
  bubbleLayoutInstruction,
  conversationStrategyInstruction,
  decideConversationPolicy,
  isLongFormRequest,
  maxOutputTokens,
  shouldUseDeepThinkingForTurn,
  STANDARD_MAX_OUTPUT_TOKENS,
  THINKING_MAX_OUTPUT_TOKENS,
} from "../apps/web/src/lib/chat/conversation-policy.ts";
import { detectConversationMode } from "../apps/web/src/lib/chat/mode.ts";
import {
  readPersistedRobotPolicy,
  withPersistedRobotPolicy,
} from "../apps/web/src/lib/companion/state-policy.ts";
import { voiceExamplesForMode } from "../apps/web/src/lib/persona/voice-examples.ts";

const sideParking = decideConversationPolicy({
  mode: detectConversationMode("今天练了侧方停车。"),
  userText: "今天练了侧方停车。",
});
assert.equal(sideParking.move, "participate");
assert.equal(sideParking.threadState, "open");
assert.equal(sideParking.questionPolicy, "avoid");
assert.equal(sideParking.allowTopicSwitch, false);
assert.match(conversationStrategyInstruction(sideParking), /接住 → 贡献 → 留白/);
assert.match(conversationStrategyInstruction(sideParking), /默认不用问句收尾/);

const deepThread = decideConversationPolicy({
  mode: "analysis",
  userText: "所以我更在意的其实不是答案，而是知情权和自主权。",
  recentMessages: [
    { role: "user", text: "如果真相会伤人，隐瞒还是善意吗？" },
    { role: "assistant", text: "善意不能自动替代当事人的选择权，关键是由谁承担后果。" },
    { role: "user", text: "但完全公开也可能把风险都推给对方。" },
    { role: "assistant", text: "对，所以矛盾不只是说不说，而是怎样保留对方的自主判断。" },
    { role: "user", text: "所以我更在意的其实不是答案，而是知情权和自主权。" },
  ],
});
assert.equal(deepThread.threadState, "active");
assert.equal(deepThread.allowTopicSwitch, false);
assert.match(conversationStrategyInstruction(deepThread), /不能因为它们存在就突然另起话题/);

for (const acknowledgement of ["嗯", "还好"]) {
  const decision = decideConversationPolicy({
    mode: "casual",
    userText: acknowledgement,
  });
  assert.equal(decision.move, "participate");
  assert.equal(decision.threadState, "open");
  assert.equal(decision.allowTopicSwitch, false);
}

const pendingQuestion = decideConversationPolicy({
  mode: "casual",
  userText: "还好",
  recentMessages: [
    { role: "assistant", text: "今天练车顺不顺？" },
    { role: "user", text: "还好" },
  ],
});
assert.equal(pendingQuestion.threadState, "active");
assert.equal(pendingQuestion.move, "continue_thread");
assert.equal(pendingQuestion.allowTopicSwitch, false);

const dailyAnswerToCurrentQuestion = decideConversationPolicy({
  mode: "casual",
  userText: "今天练了侧方停车。",
  recentMessages: [
    { role: "assistant", text: "今天打算练什么？" },
    { role: "user", text: "今天练了侧方停车。" },
  ],
});
assert.equal(
  dailyAnswerToCurrentQuestion.threadState,
  "active",
  "日常时间词本身不是换题信号，直接回答当前问题时仍应保持 thread",
);

const oneOffQuestion = decideConversationPolicy({
  mode: "factual",
  userText: "侧方停车考试有时间限制吗？",
});
assert.equal(
  oneOffQuestion.threadState,
  "open",
  "单轮明确问题在回答后可以进入 idle 仲裁，不能与持续活跃 thread 混为一谈",
);
assert.equal(oneOffQuestion.move, "answer");
assert.equal(oneOffQuestion.allowTopicSwitch, false);

const settled = decideConversationPolicy({
  mode: "casual",
  userText: "明白了，这个问题解决了。",
});
assert.equal(settled.threadState, "settled");
assert.equal(settled.move, "close");
assert.equal(settled.allowTopicSwitch, true);

const departing = decideConversationPolicy({
  mode: "casual",
  userText: "我先去忙了，回头再聊。",
});
assert.equal(departing.threadState, "departing");
assert.equal(departing.allowTopicSwitch, false);

const notSettledYet = decideConversationPolicy({
  mode: "casual",
  userText: "这个问题清楚了，不过我还有一层担心。",
});
assert.notEqual(notSettledYet.threadState, "settled");
assert.equal(notSettledYet.allowTopicSwitch, false);

assert.equal(detectConversationMode("有点累。"), "emotional");
assert.equal(detectConversationMode("有些累了。"), "emotional");

assert.equal(STANDARD_MAX_OUTPUT_TOKENS, 1800);
assert.equal(THINKING_MAX_OUTPUT_TOKENS, 3200);
assert.equal(maxOutputTokens(false), 1800);
assert.equal(maxOutputTokens(true), 3200);

assert.equal(
  shouldUseDeepThinkingForTurn({
    mode: "casual",
    userText: "嗯",
    recentUserTexts: ["我更在意真相、知情权和自主权之间的冲突。"],
    threadState: "active",
  }),
  true,
  "深话题里的短接续不能突然关闭 thinking",
);
assert.equal(
  shouldUseDeepThinkingForTurn({
    mode: "casual",
    userText: "今天练了侧方停车。",
    threadState: "open",
  }),
  false,
  "普通日常分享仍走轻量路径",
);

const deepHistory = [
  { role: "user", text: "我觉得真相和知情权之间最难的是谁来承担后果。" },
  { role: "assistant", text: "善意不能自动替代当事人的选择权，承担后果的人应有判断空间。" },
  { role: "user", text: "但是完全公开也可能让自主权变成另一种压力。" },
  { role: "assistant", text: "所以矛盾不只是公开或隐瞒，而是如何保留选择又不转嫁风险。" },
];
const newDailyText = "今天练了侧方停车。";
const newDailyMode = detectConversationMode(newDailyText);
const newDailyAfterDeep = decideConversationPolicy({
  mode: newDailyMode,
  userText: newDailyText,
  recentMessages: [
    ...deepHistory,
    { role: "user", text: newDailyText },
  ],
});
assert.equal(newDailyMode, "casual");
assert.equal(newDailyAfterDeep.move, "participate");
assert.equal(newDailyAfterDeep.threadState, "open");
assert.equal(
  shouldUseDeepThinkingForTurn({
    mode: newDailyMode,
    userText: newDailyText,
    recentUserTexts: deepHistory
      .filter((message) => message.role === "user")
      .map((message) => message.text),
    threadState: newDailyAfterDeep.threadState,
  }),
  false,
  "用户明确开启日常新话题时不得继承上一深话题的 thinking",
);

for (const continuationText of ["嗯", "继续", "嗯，继续。"]) {
  const continuation = decideConversationPolicy({
    mode: "casual",
    userText: continuationText,
    recentMessages: [
      ...deepHistory,
      { role: "user", text: continuationText },
    ],
  });
  assert.equal(continuation.move, "continue_thread");
  assert.equal(continuation.threadState, "active");
  assert.equal(
    shouldUseDeepThinkingForTurn({
      mode: "casual",
      userText: continuationText,
      recentUserTexts: deepHistory
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      threadState: continuation.threadState,
    }),
    true,
    `深话题后的“${continuationText}”应继承 active + thinking`,
  );
}

const persistedAnalysisContinuationText = "嗯，继续。";
const persistedAnalysisAssistant = withPersistedRobotPolicy({
  id: "analysis-assistant",
  role: "assistant",
  metadata: {
    threadState: "active",
    conversationMove: "answer",
    bubbleLayout: "single",
  },
  parts: [
    {
      type: "text",
      text: "你退缩的不只是风险，也可能是认真之后仍然失败的可能。",
    },
  ],
});
const reloadedAnalysisAssistant = {
  id: persistedAnalysisAssistant.id,
  role: persistedAnalysisAssistant.role,
  parts: JSON.parse(JSON.stringify(persistedAnalysisAssistant.parts)),
};
const restoredAnalysisPolicy = readPersistedRobotPolicy(
  reloadedAnalysisAssistant,
);
assert.equal(restoredAnalysisPolicy?.threadState, "active");
assert.equal(restoredAnalysisPolicy?.conversationMove, "answer");
const persistedAnalysisContinuation = decideConversationPolicy({
  mode: "casual",
  userText: persistedAnalysisContinuationText,
  recentMessages: [
    { role: "user", text: "请分析一下，我为什么总在关键时候退缩。" },
    {
      role: "assistant",
      text: reloadedAnalysisAssistant.parts[0].text,
    },
    { role: "user", text: persistedAnalysisContinuationText },
  ],
  previousThreadState: restoredAnalysisPolicy?.threadState,
  previousConversationMove: restoredAnalysisPolicy?.conversationMove,
});
assert.equal(persistedAnalysisContinuation.move, "continue_thread");
assert.equal(persistedAnalysisContinuation.threadState, "active");
assert.equal(persistedAnalysisContinuation.continuesPriorActiveThread, true);
assert.equal(
  shouldUseDeepThinkingForTurn({
    mode: "casual",
    userText: persistedAnalysisContinuationText,
    recentUserTexts: ["请分析一下，我为什么总在关键时候退缩。"],
    threadState: persistedAnalysisContinuation.threadState,
    continuesPriorActiveThread:
      persistedAnalysisContinuation.continuesPriorActiveThread,
  }),
  true,
  "硬编码深词表没有命中时，上一 assistant 持久化的 active/answer 仍应让短接续保持 thinking",
);

const persistedAnalysisThenDaily = decideConversationPolicy({
  mode: "casual",
  userText: newDailyText,
  recentMessages: [
    { role: "user", text: "请分析一下，我为什么总在关键时候退缩。" },
    {
      role: "assistant",
      text: "你退缩的不只是风险，也可能是认真之后仍然失败的可能。",
    },
    { role: "user", text: newDailyText },
  ],
  previousThreadState: restoredAnalysisPolicy?.threadState,
  previousConversationMove: restoredAnalysisPolicy?.conversationMove,
});
assert.equal(persistedAnalysisThenDaily.move, "participate");
assert.equal(persistedAnalysisThenDaily.threadState, "open");
assert.equal(persistedAnalysisThenDaily.continuesPriorActiveThread, false);
assert.equal(
  shouldUseDeepThinkingForTurn({
    mode: "casual",
    userText: newDailyText,
    recentUserTexts: ["请分析一下，我为什么总在关键时候退缩。"],
    threadState: persistedAnalysisThenDaily.threadState,
    continuesPriorActiveThread:
      persistedAnalysisThenDaily.continuesPriorActiveThread,
  }),
  false,
  "持久化 active thread 不能覆盖用户明确开启的新日常话题",
);

const longFormText = "请写一篇千字长文，完整展开这个判断。";
assert.equal(isLongFormRequest(longFormText), true);
const longForm = decideConversationPolicy({
  mode: detectConversationMode(longFormText),
  userText: longFormText,
});
assert.equal(longForm.longFormRequested, true);
assert.equal(longForm.move, "answer");
assert.equal(longForm.threadState, "active");
assert.match(conversationStrategyInstruction(longForm), /约千字正文/);
assert.match(
  bubbleLayoutInstruction({ thinkingEnabled: false, longFormRequested: true }),
  /一个连续聊天气泡/,
);
assert.doesNotMatch(
  bubbleLayoutInstruction({ thinkingEnabled: false, longFormRequested: true }),
  /通常 1 到 4 行/,
);

const casualAnchors = voiceExamplesForMode("casual");
assert.match(casualAnchors, /侧方这块地图也亮了/);
assert.match(casualAnchors, /人不用每天都交一份精彩日报/);
assert.doesNotMatch(casualAnchors, /会不会又把自己耗到没电/);

const emotionalAnchors = voiceExamplesForMode("emotional");
assert.doesNotMatch(
  emotionalAnchors,
  /我知道你现在(?:不想|最先)/,
  "语气锚点不应把当下心理推测写成确定事实",
);
assert.match(emotionalAnchors, /听起来|像是/);
assert.match(voiceExamplesForMode("emotional"), /听起来不像真的不在意/);
assert.doesNotMatch(voiceExamplesForMode("emotional"), /我知道你不是不在意/);

console.log(
  JSON.stringify({
    ok: true,
    sideParking,
    deepThread: {
      move: deepThread.move,
      threadState: deepThread.threadState,
      allowTopicSwitch: deepThread.allowTopicSwitch,
    },
    outputCaps: {
      standard: STANDARD_MAX_OUTPUT_TOKENS,
      thinking: THINKING_MAX_OUTPUT_TOKENS,
    },
  }),
);
