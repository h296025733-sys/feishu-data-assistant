export function isGroupChatType(chatType: string): boolean {
  return /group|chat/i.test(chatType) && !/p2p|private/i.test(chatType);
}

export function storeConversationSessionKey(
  tenantId: string,
  chatId: string,
  chatType: string,
  userId: string,
): string {
  const conversation = isGroupChatType(chatType) ? chatId || "group" : "private";
  return `${tenantId}:${conversation}:${userId}`;
}

export function privateConversationSessionKey(userId: string): string {
  return `private:${userId}`;
}
