export function buildDemoResponse(userText: string) {
  const direct = /直接|别安慰|只要答案|结论/.test(userText);
  const distressed = /累|烦|难过|崩溃|不开心|焦虑|压力/.test(userText);

  if (direct) {
    return "直接说：当前模型没有连接成功，所以这条不能假装回答。换一个可用的通用对话模型后再来。";
  }

  if (distressed) {
    return "那就先不分析。只是现在模型没连上，等它恢复后我们再接着聊。";
  }

  return "模型现在没连上，我不拿演示话术糊弄你。恢复后再接着说。";
}
