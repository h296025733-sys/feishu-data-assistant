export function assertUserAllowed(userId: string, allowedIds: Set<string>): void {
  if (!userId || !allowedIds.has(userId)) throw new Error("当前用户未被授权使用此机器人");
}
