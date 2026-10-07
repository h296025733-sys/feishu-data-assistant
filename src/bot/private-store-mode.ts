import type { CrossTenantConversationContext } from "./cross-tenant-query.js";
import { normalizeText } from "../utils/value.js";

export interface PrivateStoreDescriptor {
  id: string;
  displayName: string;
  aliases: string[];
}

interface PrivateStoreSelection {
  tenantId: string;
  updatedAt: number;
}

export class PrivateStoreModeRegistry {
  private readonly selections = new Map<string, PrivateStoreSelection>();

  public constructor(private readonly ttlMs = 2 * 60 * 60_000) {}

  public select(sessionKey: string, tenantId: string, now = Date.now()): void {
    this.selections.set(sessionKey, { tenantId, updatedAt: now });
  }

  public current(sessionKey: string, now = Date.now()): string | null {
    const selection = this.selections.get(sessionKey);
    if (!selection) return null;
    if (now - selection.updatedAt >= this.ttlMs) {
      this.selections.delete(sessionKey);
      return null;
    }
    return selection.tenantId;
  }

  public clear(sessionKey: string): void {
    this.selections.delete(sessionKey);
  }
}

export function resolvePrivateStoreMenuTarget(
  question: string,
  stores: PrivateStoreDescriptor[],
): string | null {
  const text = normalizeText(question);
  const matched = stores.filter((store) => [store.id, store.displayName, ...store.aliases]
    .map(normalizeText)
    .filter(Boolean)
    .some((alias) => [
      `${alias}菜单`,
      `${alias}帮助`,
      `进入${alias}`,
      `选择${alias}`,
    ].includes(text)));
  return matched.length === 1 ? matched[0].id : null;
}

export function shouldUseSelectedPrivateStore(
  question: string,
  context: CrossTenantConversationContext,
  stores: PrivateStoreDescriptor[],
): boolean {
  const text = normalizeText(question);
  const explicitlyNamesStore = stores.some((store) => [store.id, store.displayName, ...store.aliases]
    .map(normalizeText)
    .filter(Boolean)
    .some((alias) => text.includes(alias)));
  if (explicitlyNamesStore) return false;
  if (/(?:跨店|所有店|全部店|各店|每家店|两家店|店铺对比|店铺比较|哪家(?:店)?|哪个店铺|分别.*店|比较.*店|对比.*店)/.test(question)) {
    return false;
  }
  const continuesCrossStoreQuestion = ["store_ranking", "product_ranking", "cross_summary"].includes(context.lastIntent ?? "")
    && /^(?:那|那么|再|然后|销量呢|销售额呢|单量呢|这个月呢|最近呢|同样范围)/.test(question.trim());
  return !continuesCrossStoreQuestion;
}
