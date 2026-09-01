import type { ConversationMode } from "./mode";

/**
 * 普通模式的输出上限只负责给长回复留出空间，不代表每轮都应写满。
 * DeepSeek thinking 模式保留更高预算，以容纳推理与最终回答。
 */
export const STANDARD_MAX_OUTPUT_TOKENS = 1800;
export const THINKING_MAX_OUTPUT_TOKENS = 3200;

export type ConversationMove =
  | "participate"
  | "continue_thread"
  | "support"
  | "answer"
  | "close";

export type ThreadState = "active" | "open" | "settled" | "departing";

export type ConversationPolicyMessage = {
  role: "user" | "assistant";
  text: string;
};

export type ConversationPolicyDecision = {
  move: ConversationMove;
  threadState: ThreadState;
  /** active thread 未闭合时，召回结果只能辅助当前话题，不能另起话题。 */
  allowTopicSwitch: boolean;
  /** 问句不是日常闲聊的默认推进手段。 */
  questionPolicy: "avoid" | "optional" | "allowed";
  longFormRequested: boolean;
  /** 当前短句是否由上一轮持久化的 active thread 明确继承。 */
  continuesPriorActiveThread: boolean;
  reasons: string[];
};

const DEPARTURE_PATTERN =
  /(?:^|[，。！？\s])(晚安(?:啦|了|呀|啊)?|我?先睡(?:了|觉)?|睡了|我?去忙(?:了)?|我?先忙(?:了)?|不聊了|下次再聊|回头再聊|先这样(?:吧)?|我?先走(?:了)?|我?去(?:开车|吃饭|洗澡|出门)(?:了)?)(?:[，。！？\s]|$)/;

const SETTLED_PATTERN =
  /(?:问题)?(?:解决|清楚|弄懂|明白)(?:了|啦)|我懂了|知道了[，。]?(?:谢谢|多谢)?|就这样(?:吧)?|到这里(?:吧)?|不用继续(?:了)?|这事先放下/;

const REASONING_PATTERN =
  /因为|所以|但是|可是|不过|其实|我觉得|我认为|换句话说|也就是说|我的意思|问题是|如果|真相|知情权|自主权|边界|选择权|价值|意义|原则|矛盾/;

const EXPLICIT_QUESTION_PATTERN = /[？?]|为什么|怎么|怎麽|如何|是不是|能不能|要不要|该不该|你觉得/;

const LONG_FORM_PATTERN =
  /(?:请|帮我|給我|给我|希望|需要|想要|能不能)?.{0,6}(?:写|說|说|讲|講|分析|展开|展開|回答).{0,10}(?:千字|一千字|1000\s*字|长文|長文)|(?:请|帮我|給我|给我|希望|需要|想要).{0,10}(?:千字|一千字|1000\s*字|长文|長文)|详细(?:地)?展开|詳細(?:地)?展開|完整(?:地)?展开|完整(?:地)?展開|深入(?:地)?分析|全面(?:地)?分析|尽可能详细|儘可能詳細|写长一点|寫長一點|讲长一点|講長一點/;

const ACKNOWLEDGEMENT_PATTERN =
  /^(?:嗯+|哦+|好(?:的|吧|啊|呀)?|行|还好|一般|没事|没什么|就那样|差不多|是的|对|不是|算了)[。！~～…]*$/;

const SHORT_CONTINUATION_PATTERN =
  /^(?:嗯+[，,\s]*)?(?:继续|你继续|接着说|你接着说|说下去|然后呢|再说说|展开说说)[。！？!?~～…]*$/;

const CLEAR_NEW_THREAD_PATTERN =
  /^(?:换个话题|说点别的|另说一件事)(?:[，,：:\s]|$)/;

const DAILY_NEW_THREAD_PATTERN =
  /^(?:对了[，,：:\s]*)?(?:今天|昨天|明天|刚才|刚刚|这两天|最近).{2,}$/;

function compactLength(text: string) {
  return text.replace(/[\s，。！？、,.!?；;：:“”'‘’（）()\-—…~～]/g, "").length;
}

function isSubstantive(text: string) {
  return compactLength(text) >= 10 || REASONING_PATTERN.test(text);
}

function previousAssistantMessage(
  messages: ConversationPolicyMessage[],
  userText: string,
) {
  const trimmedUserText = userText.trim();
  let skippedCurrentUser = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !skippedCurrentUser &&
      message.role === "user" &&
      message.text.trim() === trimmedUserText
    ) {
      skippedCurrentUser = true;
      continue;
    }
    if (message.role === "assistant" && message.text.trim()) return message.text.trim();
  }
  return "";
}

function hasSustainedEngagement(messages: ConversationPolicyMessage[]) {
  const recent = messages.filter((message) => message.text.trim()).slice(-8);
  const substantiveUsers = recent.filter(
    (message) => message.role === "user" && isSubstantive(message.text),
  ).length;
  const substantiveAssistants = recent.filter(
    (message) => message.role === "assistant" && isSubstantive(message.text),
  ).length;
  const reasoningTurns = recent.filter((message) => REASONING_PATTERN.test(message.text)).length;

  return (
    substantiveUsers >= 2 &&
    substantiveAssistants >= 1 &&
    (reasoningTurns >= 2 || recent.length >= 6)
  );
}

function messagesBeforeCurrentUser(
  messages: ConversationPolicyMessage[],
  userText: string,
) {
  const normalized = userText.trim();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (
      messages[index].role === "user" &&
      messages[index].text.trim() === normalized
    ) {
      return messages.slice(0, index);
    }
  }
  return messages;
}

function isShortContinuation(text: string) {
  return (
    ACKNOWLEDGEMENT_PATTERN.test(text.trim()) ||
    SHORT_CONTINUATION_PATTERN.test(text.trim())
  );
}

export function isLongFormRequest(userText: string) {
  return LONG_FORM_PATTERN.test(userText.trim());
}

export function maxOutputTokens(thinkingEnabled: boolean) {
  return thinkingEnabled
    ? THINKING_MAX_OUTPUT_TOKENS
    : STANDARD_MAX_OUTPUT_TOKENS;
}

const NUANCED_TURN_PATTERN =
  /算了|没事|随便|都行|无所谓|你决定|其实|但是|可是|反话|隐喻|纠结|委屈|失望|在意|关系|误会|为什么|怎么办/;
const DEEP_THREAD_PATTERN =
  /真相|知情权|自主权|选择权|价值观?|意义|原则|边界|矛盾|伦理|责任|自由意志/;

/**
 * 模型推理能力是 Conversation Policy 的执行资源，不再只由一个宽泛 mode 决定。
 * 这样深话题中的短接续不会因为“嗯/还好”突然掉回无思考路径。
 */
export function shouldUseDeepThinkingForTurn(input: {
  mode: ConversationMode;
  userText: string;
  recentUserTexts?: string[];
  threadState?: ThreadState;
  continuesPriorActiveThread?: boolean;
}) {
  const recentUserTexts = input.recentUserTexts ?? [];
  if (input.mode === "analysis") return true;
  if (input.mode === "advice") {
    return input.userText.length >= 16 || NUANCED_TURN_PATTERN.test(input.userText);
  }
  if (input.mode === "emotional") {
    return (
      NUANCED_TURN_PATTERN.test(input.userText) ||
      (isShortContinuation(input.userText) &&
        recentUserTexts.some((text) => NUANCED_TURN_PATTERN.test(text)))
    );
  }
  if (input.mode === "factual" && input.userText.length >= 100) return true;

  const currentIsDeep = DEEP_THREAD_PATTERN.test(input.userText);
  const continuingDeepThread =
    input.threadState === "active" &&
    isShortContinuation(input.userText) &&
    (input.continuesPriorActiveThread === true ||
      recentUserTexts.some((text) => DEEP_THREAD_PATTERN.test(text)));
  return currentIsDeep || continuingDeepThread;
}

/**
 * 在模型生成前选择“这一轮做什么”，而不是把推进方式留给模型自行猜测。
 * 规则刻意保守：不确定是否闭合时保留为 open，不主动把日常短句解释成结束对话。
 */
export function decideConversationPolicy(input: {
  mode: ConversationMode;
  userText: string;
  recentMessages?: ConversationPolicyMessage[];
  previousThreadState?: ThreadState;
  previousConversationMove?: ConversationMove;
}): ConversationPolicyDecision {
  const text = input.userText.trim();
  const recentMessages = input.recentMessages ?? [];
  const reasons: string[] = [];
  const longFormRequested = isLongFormRequest(text);

  if (DEPARTURE_PATTERN.test(text)) {
    return {
      move: "close",
      threadState: "departing",
      allowTopicSwitch: false,
      questionPolicy: "avoid",
      longFormRequested,
      continuesPriorActiveThread: false,
      reasons: ["用户明确准备离开"],
    };
  }

  if (
    SETTLED_PATTERN.test(text) &&
    !/但是|但我|不过|可是|还有|接下来|接着|另外/.test(text)
  ) {
    return {
      move: "close",
      threadState: "settled",
      allowTopicSwitch: true,
      questionPolicy: "avoid",
      longFormRequested,
      continuesPriorActiveThread: false,
      reasons: ["用户明确表示当前事项已经收束"],
    };
  }

  const previousAssistant = previousAssistantMessage(recentMessages, text);
  const answeringPendingQuestion = /[？?]\s*$/.test(previousAssistant);
  const sustainedEngagement = hasSustainedEngagement(recentMessages);
  const explicitQuestion = EXPLICIT_QUESTION_PATTERN.test(text);
  const currentIsDeep = DEEP_THREAD_PATTERN.test(text);
  const priorMessages = messagesBeforeCurrentUser(recentMessages, text);
  const priorHasDeepThread = priorMessages
    .slice(-6)
    .some((message) => DEEP_THREAD_PATTERN.test(message.text));
  const continuingDeepThread =
    isShortContinuation(text) && priorHasDeepThread;
  const continuesPriorActiveThread =
    isShortContinuation(text) &&
    input.previousThreadState === "active" &&
    input.previousConversationMove !== "close";
  const explicitNewThread =
    input.mode !== "analysis" &&
    !currentIsDeep &&
    (CLEAR_NEW_THREAD_PATTERN.test(text) ||
      (!answeringPendingQuestion &&
        (priorHasDeepThread ||
          (input.previousThreadState === "active" &&
            input.previousConversationMove === "continue_thread")) &&
        DAILY_NEW_THREAD_PATTERN.test(text)));

  let threadState: ThreadState = "open";
  if (
    input.mode === "analysis" ||
    longFormRequested ||
    continuesPriorActiveThread ||
    continuingDeepThread ||
    (!explicitNewThread && sustainedEngagement) ||
    (!explicitNewThread && answeringPendingQuestion)
  ) {
    threadState = "active";
    if (input.mode === "analysis") reasons.push("当前为分析话题");
    if (longFormRequested) reasons.push("用户明确要求长文或详细展开");
    if (continuesPriorActiveThread) {
      reasons.push("用户正在接续上一轮持久化的 active thread");
    }
    if (continuingDeepThread) reasons.push("用户正在短接续最近的深度话题");
    if (sustainedEngagement) reasons.push("最近多轮存在持续参与");
    if (answeringPendingQuestion) reasons.push("用户正在回应当前话题中的问题");
  } else if (explicitNewThread) {
    reasons.push("用户明确提供了新的日常话题，结束上一 thread 的继承");
  } else if (ACKNOWLEDGEMENT_PATTERN.test(text)) {
    reasons.push("低信息回应仍视为当前话题的开放接续，而非结束信号");
  } else {
    reasons.push("当前话题尚未明确收束");
  }

  let move: ConversationMove;
  let questionPolicy: ConversationPolicyDecision["questionPolicy"];
  switch (input.mode) {
    case "analysis":
    case "advice":
    case "factual":
      move = explicitQuestion || input.mode !== "analysis" ? "answer" : "continue_thread";
      questionPolicy = "allowed";
      break;
    case "emotional":
      move = "support";
      questionPolicy = "optional";
      break;
    case "intimate":
      move = threadState === "active" ? "continue_thread" : "participate";
      questionPolicy = "optional";
      break;
    case "casual":
    default:
      move = threadState === "active" ? "continue_thread" : "participate";
      questionPolicy = "avoid";
      break;
  }

  if (longFormRequested) {
    move = "answer";
    questionPolicy = "allowed";
  }

  return {
    move,
    threadState,
    allowTopicSwitch: false,
    questionPolicy,
    longFormRequested,
    continuesPriorActiveThread,
    reasons,
  };
}

/** 可直接放入 system prompt 的本轮回复策略。 */
export function conversationStrategyInstruction(
  decision: ConversationPolicyDecision,
) {
  const sections = [
    `本轮 Conversation Move：${decision.move}；当前 Thread State：${decision.threadState}。`,
  ];

  if (decision.move === "participate" || decision.move === "continue_thread") {
    sections.push(
      "采用“接住 → 贡献 → 留白”，不要默认采用“接住 → 提问”。先回应用户刚给出的内容，再自己贡献一小步：可以是有依据的观察、态度、自然联想、轻微玩笑、与当前话题有关且已确认的记忆，或明确标成“听起来/我猜”的当下推测。",
      "贡献之后可以自然停住；没有问号也能给用户留下继续空间。只有真的需要信息时才问，不能用连续追问维持对话，也不要把生活分享迅速变成建议、任务或规划。",
    );
  } else if (decision.move === "support") {
    sections.push(
      "先贴住用户此刻的感受并贡献陪伴或态度；提问只是可选动作，不要用问题把情绪回应做成采访。",
    );
  } else if (decision.move === "answer") {
    sections.push(
      "先直接完成用户要的回答；只有缺少会实质改变答案的关键信息时才追问。",
    );
  } else {
    sections.push("顺着用户的收束或离开信号回应，不另开新任务，也不临时抛出旧话题。");
  }

  if (!decision.allowTopicSwitch) {
    sections.push(
      "当前话题尚未获得换题资格。继续当前 thread；召回到的 Open Loop、旧 Topic 或记忆只能在确实帮助当前话题时使用，不能因为它们存在就突然另起话题。",
    );
  }

  if (decision.questionPolicy === "avoid") {
    sections.push("本轮默认不用问句收尾；自然陈述和留白优先于追加一个问题。");
  }

  if (decision.longFormRequested) {
    sections.push(
      "用户本轮明确要求长文或详细展开：允许一个连续回复容纳约千字正文，不受通常 1 到 4 个短气泡的节奏限制；输出上限只是容量，不要求凑满。",
    );
  }

  return sections.join("\n");
}

export function bubbleLayoutInstruction(input: {
  thinkingEnabled: boolean;
  longFormRequested: boolean;
}) {
  if (input.longFormRequested) {
    return "用户本轮明确要求长文或详细展开：把完整正文放在一个连续聊天气泡里，可以正常分段；不要按短聊天气泡拆碎，也不要为了达到上限凑字数。";
  }
  if (input.thinkingEnabled) {
    return "本轮是深度话题：把完整回应放在一个连续聊天气泡里；保持结构清楚，不为了形式强行拆成多个短气泡。";
  }
  return "本轮按真人聊天节奏输出：每说完一个自然短句组就换一行，每一行会成为独立聊天气泡；通常 1 到 4 行，每行 1 到 2 句，不要使用空行。内容很短时不强行拆分。";
}
