import type { MessageUnderstanding } from "../ai/types.js";

export type BotConversationMode = "group" | "private";

export function isBasicConversationCandidate(question: string): boolean {
  const text = question.trim();
  return /^(?:你好|您好|嗨|哈喽|hello|hi|在吗|在不在|早上好|上午好|中午好|下午好|晚上好|谢谢|感谢|多谢|辛苦了|好的谢谢|好谢谢|ok谢谢|thanks?|再见|拜拜|bye|先这样|回头聊|你是谁|你叫什么|你是干嘛的|你能做什么|你能干嘛|你会什么)(?:呀|啊|哦|啦|呢)?[!！。,.，?？~～]*$/i.test(text);
}

export function resolveBasicConversationReply(
  question: string,
  understanding: MessageUnderstanding | null,
  mode: BotConversationMode,
  storeNames: string[],
): string | null {
  if (understanding?.intentHint === "chitchat" && understanding.directReply?.trim()) {
    return understanding.directReply.trim();
  }
  const text = question.trim();
  if (/^(?:你好|您好|嗨|哈喽|hello|hi|在吗|在不在|早上好|上午好|中午好|下午好|晚上好)(?:呀|啊|哦|啦|呢)?[!！。,.，?？~～]*$/i.test(text)) {
    return mode === "group"
      ? "我在。🙂 这个群只看当前绑定店铺；查数据直接说人话，想看快捷入口就发“菜单”。"
      : `我在。🙂 私聊可以按店名查询，也可以比较 ${storeNames.join(" / ")}；想看快捷入口就发“菜单”。`;
  }
  if (/^(?:谢谢|感谢|多谢|辛苦了|好的谢谢|好谢谢|ok谢谢|thanks?)(?:呀|啊|哦|啦|呢)?[!！。,.，~～]*$/i.test(text)) {
    return "不客气，有经营问题继续发给我就行。";
  }
  if (/^(?:再见|拜拜|bye|先这样|回头聊)(?:呀|啊|哦|啦|呢)?[!！。,.，~～]*$/i.test(text)) {
    return "好，随时找我。👋";
  }
  if (/^(?:你是谁|你叫什么|你是干嘛的|你能做什么|你能干嘛|你会什么)(?:呀|啊|哦|啦|呢)?[!！。,.，?？]*$/i.test(text)) {
    return mode === "group"
      ? "我是当前店铺群的经营机器人：能查经营数据、连续追问、查看同步状态和打开快捷菜单；这个群不会查询其他店。"
      : `我是多店经营机器人的私聊工作区：能分别查询 ${storeNames.join(" / ")}，也能做跨店比较和连续追问。`;
  }
  if (understanding?.intentHint === "chitchat") {
    return "我在听。🙂 如果要查经营数据，直接按平时说话就行；也可以发“菜单”看快捷入口。";
  }
  return null;
}
