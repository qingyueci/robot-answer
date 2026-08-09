export const EMOTION_TTL_MS = 12 * 60 * 60 * 1000;
export const AUTO_TOPIC_DELAY_MS = 45 * 1000;

export function emotionExpiresAt(now = new Date()) {
  return new Date(now.getTime() + EMOTION_TTL_MS).toISOString();
}

export function isFollowUpQuietHours(now = new Date()) {
  const hour = now.getHours();
  return hour < 9 || hour > 23 || (hour === 23 && now.getMinutes() >= 30);
}

export function followUpMessage(content: string, count: number) {
  const topic = content
    .replace(/^观棋(?:正在|准备|计划|想要|希望|决定)?/, "")
    .replace(/[。；;]+$/, "")
    .trim()
    .slice(0, 72);
  return count <= 1
    ? `你前面提到「${topic}」，后来有一点新进展吗？没有也没关系。`
    : `关于「${topic}」，我再轻轻问一次。现在还想继续就告诉我；不想的话，我先放下。`;
}

export function shouldScheduleAutoTopic(
  userText: string,
  assistantText: string,
) {
  const user = userText.trim();
  const assistant = assistantText.trim();
  if (!user || !assistant) return false;
  if (/晚安|睡了|去忙|先忙|不聊了|下次再聊|回头再聊|先这样/.test(user)) {
    return false;
  }
  return !/[？?]\s*$/.test(assistant);
}
