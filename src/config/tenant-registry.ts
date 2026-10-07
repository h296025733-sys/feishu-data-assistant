import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadBusinessProfileFile, type BusinessProfile } from "./business-profile.js";
import type { AppEnv } from "./env.js";

const envReference = z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/);
const tenantSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/),
  enabled: z.boolean(),
  profileFile: z.string().trim().min(1),
  routing: z.object({
    groupChatIds: z.array(z.string().trim().min(1)).max(1, "第一阶段每家店只能绑定一个专属群"),
    allowPrivateFallback: z.boolean(),
    allowUnboundGroupFallback: z.boolean().optional().default(false),
  }),
  base: z.object({
    appTokenEnv: envReference,
    tableIdEnv: envReference,
    baseUrlEnv: envReference,
  }),
  ai: z.object({
    apiKeyEnv: envReference,
    baseUrlEnv: envReference,
    modelEnv: envReference,
  }),
  access: z.object({
    groupMembersEqual: z.boolean(),
    scheduleAdminUserIdsEnv: envReference,
  }),
  queryConcurrency: z.number().int().min(1).max(10),
});
const registrySchema = z.object({
  schemaVersion: z.literal(1),
  defaultTenantId: z.string().trim().min(1),
  globalQueryConcurrency: z.number().int().min(1).max(32),
  privateAccess: z.object({
    enabled: z.boolean(),
    userIdsEnv: envReference,
  }).optional(),
  tenants: z.array(tenantSchema).min(1),
});
const runtimeBindingsSchema = z.object({
  schemaVersion: z.literal(1),
  bindings: z.record(z.string().trim().min(1), z.string().trim().min(1)),
  updatedAt: z.string(),
  updatedBy: z.string().trim().min(1),
});

export type TenantBinding = z.infer<typeof tenantSchema>;
export interface ResolvedTenant {
  binding: TenantBinding;
  profile: BusinessProfile;
  env: AppEnv;
}

export type GroupRouteSource = "configured" | "runtime";
export interface GroupRoute {
  tenantId: string;
  source: GroupRouteSource;
}

export class TenantRegistry {
  public readonly globalQueryConcurrency: number;
  public readonly privateAccess: { enabled: boolean; userIdsEnv: string };
  private readonly tenants: Map<string, ResolvedTenant>;
  private readonly groupRoutes = new Map<string, GroupRoute>();
  private readonly defaultTenantId: string;
  private readonly runtimeBindingsPath: string;
  private readonly runtimeBindings = new Map<string, string>();

  public constructor(
    rootEnv: AppEnv,
    registryFile?: string,
    runtimeBindingsFile?: string,
  ) {
    const usesRuntimeRegistry = registryFile == null;
    const selectedRegistryFile = registryFile ?? process.env.TENANT_REGISTRY_FILE ?? "config/tenant-registry.json";
    const registryPath = path.resolve(process.cwd(), selectedRegistryFile);
    const selectedRuntimeBindingsFile = runtimeBindingsFile
      ?? (usesRuntimeRegistry
        ? process.env.TENANT_GROUP_BINDINGS_FILE ?? ".runtime/tenant-group-bindings.json"
        : path.join(path.dirname(registryPath), "runtime-bindings.json"));
    this.runtimeBindingsPath = path.resolve(process.cwd(), selectedRuntimeBindingsFile);
    const parsed = registrySchema.safeParse(JSON.parse(readFileSync(registryPath, "utf8")));
    if (!parsed.success) throw new Error(`店铺租户注册表无效（${registryPath}）：${z.prettifyError(parsed.error)}`);
    this.defaultTenantId = parsed.data.defaultTenantId;
    this.globalQueryConcurrency = parsed.data.globalQueryConcurrency;
    this.privateAccess = parsed.data.privateAccess ?? {
      enabled: parsed.data.tenants.some((tenant) => tenant.enabled && tenant.routing.allowPrivateFallback),
      userIdsEnv: "BOT_ALLOWED_USER_IDS",
    };
    this.tenants = new Map();
    for (const binding of parsed.data.tenants.filter((item) => item.enabled)) {
      if (this.tenants.has(binding.id)) throw new Error(`店铺租户ID重复：${binding.id}`);
      const profile = loadBusinessProfileFile(binding.profileFile);
      const env = tenantEnv(rootEnv, binding);
      this.tenants.set(binding.id, { binding, profile, env });
      for (const chatId of binding.routing.groupChatIds) {
        this.addGroupRoute(chatId, binding.id, "configured");
      }
    }
    if (!this.tenants.has(this.defaultTenantId)) throw new Error(`默认店铺租户不存在或未启用：${this.defaultTenantId}`);
    this.validateTenantIsolation();
    this.loadRuntimeBindings();
    if (this.tenants.size > 1 && [...this.tenants.values()].some((tenant) => tenant.binding.routing.allowUnboundGroupFallback)) {
      throw new Error("启用多个店铺前必须关闭未绑定群回退，并为每个店铺填写明确群聊ID");
    }
  }

  public all(): ResolvedTenant[] { return [...this.tenants.values()]; }
  public byId(id: string): ResolvedTenant | null { return this.tenants.get(id) ?? null; }
  public default(): ResolvedTenant { return this.tenants.get(this.defaultTenantId)!; }

  public groupRoute(chatId: string): GroupRoute | null {
    return this.groupRoutes.get(chatId) ?? null;
  }

  public groupRoutesForTenant(tenantId: string): Array<{ chatId: string; source: GroupRouteSource }> {
    if (!this.tenants.has(tenantId)) throw new Error(`店铺租户不存在或未启用：${tenantId}`);
    return [...this.groupRoutes.entries()]
      .filter(([, route]) => route.tenantId === tenantId)
      .map(([chatId, route]) => ({ chatId, source: route.source }))
      .sort((a, b) => a.chatId.localeCompare(b.chatId));
  }

  public bindGroup(chatId: string, tenantId: string, updatedBy: string): GroupRoute {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) throw new Error("无法识别当前群聊ID");
    if (!this.tenants.has(tenantId)) throw new Error(`店铺租户不存在或未启用：${tenantId}`);
    const existing = this.groupRoutes.get(normalizedChatId);
    if (existing && existing.tenantId !== tenantId) {
      throw new Error(`这个群已经绑定到 ${existing.tenantId}，禁止直接改绑；请由系统管理员先核对并解除旧绑定`);
    }
    if (existing) return existing;
    const otherGroup = [...this.groupRoutes.entries()].find(([boundChatId, route]) => (
      boundChatId !== normalizedChatId && route.tenantId === tenantId
    ));
    if (otherGroup) {
      throw new Error(`这家店已经绑定到另一个专属群（${otherGroup[0]}）；请先在旧群解除绑定，避免两个群共享店铺上下文`);
    }
    this.runtimeBindings.set(normalizedChatId, tenantId);
    this.persistRuntimeBindings(updatedBy);
    const route: GroupRoute = { tenantId, source: "runtime" };
    this.groupRoutes.set(normalizedChatId, route);
    return route;
  }

  public unbindGroup(chatId: string, updatedBy: string): GroupRoute {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) throw new Error("无法识别当前群聊ID");
    const existing = this.groupRoutes.get(normalizedChatId);
    if (!existing) throw new Error("这个群目前没有绑定店铺");
    if (existing.source === "configured") {
      throw new Error("这个群写在静态租户配置中，请先从 tenant-registry.json 移除后重启，不能在聊天里解除");
    }
    this.runtimeBindings.delete(normalizedChatId);
    this.groupRoutes.delete(normalizedChatId);
    this.persistRuntimeBindings(updatedBy);
    return existing;
  }

  public resolve(chatId: string, chatType: string): ResolvedTenant {
    const routed = this.groupRoutes.get(chatId);
    if (routed) return this.tenants.get(routed.tenantId)!;
    const isGroup = /group|chat/i.test(chatType) && !/p2p|private/i.test(chatType);
    const fallback = this.tenants.get(this.defaultTenantId)!;
    if (isGroup && this.tenants.size === 1 && fallback.binding.routing.allowUnboundGroupFallback) return fallback;
    // 单店旧部署保留原有私聊回退。多店私聊必须由跨店路由先选定店铺，
    // 绝不能静默落到默认店铺，否则会把用户的跨店问题查成某一家店。
    if (!isGroup && this.tenants.size === 1 && fallback.binding.routing.allowPrivateFallback) return fallback;
    throw new Error("这个群还没有绑定店铺。请让系统管理员先在租户注册表中绑定群聊ID。");
  }

  private addGroupRoute(chatId: string, tenantId: string, source: GroupRouteSource): void {
    const existing = this.groupRoutes.get(chatId);
    if (existing && existing.tenantId !== tenantId) throw new Error(`群聊被重复绑定：${chatId}`);
    if (!existing) this.groupRoutes.set(chatId, { tenantId, source });
  }

  private loadRuntimeBindings(): void {
    let raw: string;
    try {
      raw = readFileSync(this.runtimeBindingsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = runtimeBindingsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`群聊运行绑定文件无效（${this.runtimeBindingsPath}）：${z.prettifyError(parsed.error)}`);
    }
    for (const [chatId, tenantId] of Object.entries(parsed.data.bindings)) {
      if (!this.tenants.has(tenantId)) throw new Error(`群聊 ${chatId} 指向不存在或停用的店铺租户：${tenantId}`);
      const configured = this.groupRoutes.get(chatId);
      if (configured && configured.tenantId !== tenantId) {
        throw new Error(`群聊 ${chatId} 的静态配置与运行绑定冲突`);
      }
      if (!configured) {
        const otherGroup = [...this.groupRoutes.entries()].find(([boundChatId, route]) => (
          boundChatId !== chatId && route.tenantId === tenantId
        ));
        if (otherGroup) {
          throw new Error(`${tenantId} 同时绑定了群 ${otherGroup[0]} 和 ${chatId}；第一阶段必须一店一群`);
        }
        this.runtimeBindings.set(chatId, tenantId);
        this.addGroupRoute(chatId, tenantId, "runtime");
      }
    }
  }

  private persistRuntimeBindings(updatedBy: string): void {
    const payload = runtimeBindingsSchema.parse({
      schemaVersion: 1,
      bindings: Object.fromEntries([...this.runtimeBindings.entries()].sort(([a], [b]) => a.localeCompare(b))),
      updatedAt: new Date().toISOString(),
      updatedBy,
    });
    mkdirSync(path.dirname(this.runtimeBindingsPath), { recursive: true });
    const temporary = `${this.runtimeBindingsPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.runtimeBindingsPath);
  }

  private validateTenantIsolation(): void {
    const seen = new Map<string, string>();
    const assertUnique = (kind: string, value: string, tenantId: string) => {
      const normalized = value.trim().toLocaleLowerCase("zh-CN");
      if (!normalized) return;
      const prior = seen.get(`${kind}:${normalized}`);
      if (prior && prior !== tenantId) {
        throw new Error(`${prior} 与 ${tenantId} 共用了同一个${kind}（${value}）；多店部署必须完全隔离`);
      }
      seen.set(`${kind}:${normalized}`, tenantId);
    };
    for (const tenant of this.tenants.values()) {
      assertUnique("店铺路由名称", tenant.profile.businessDisplayName, tenant.binding.id);
      assertUnique("店铺路由名称", tenant.profile.tiktok.shopAlias, tenant.binding.id);
      assertUnique("Base AppToken", tenant.env.FEISHU_BITABLE_APP_TOKEN, tenant.binding.id);
      assertUnique("商品映射文件", tenant.profile.tiktok.productMapFile, tenant.binding.id);
      if (tenant.profile.tiktok.shopId) assertUnique("TikTok Shop ID", tenant.profile.tiktok.shopId, tenant.binding.id);
      if (tenant.profile.tiktok.credentialProfile) {
        assertUnique("TikTok凭证档案", tenant.profile.tiktok.credentialProfile, tenant.binding.id);
      }
    }
  }
}

function tenantEnv(root: AppEnv, binding: TenantBinding): AppEnv {
  const read = (name: string, fallback = "") => (
    String(process.env[name] ?? "").trim() || String(fallback).trim()
  );
  const env: AppEnv = {
    ...root,
    FEISHU_BITABLE_APP_TOKEN: read(binding.base.appTokenEnv, root.FEISHU_BITABLE_APP_TOKEN),
    FEISHU_BITABLE_TABLE_ID: read(binding.base.tableIdEnv, root.FEISHU_BITABLE_TABLE_ID),
    FEISHU_BITABLE_URL: read(binding.base.baseUrlEnv, root.FEISHU_BITABLE_URL),
    DEEPSEEK_API_KEY: read(binding.ai.apiKeyEnv, root.DEEPSEEK_API_KEY),
    DEEPSEEK_BASE_URL: read(binding.ai.baseUrlEnv, root.DEEPSEEK_BASE_URL),
    DEEPSEEK_MODEL: read(binding.ai.modelEnv, root.DEEPSEEK_MODEL),
  };
  if (!env.FEISHU_BITABLE_APP_TOKEN) throw new Error(`${binding.id}缺少Base AppToken环境变量：${binding.base.appTokenEnv}`);
  return env;
}

export function tenantScheduleAdmins(tenant: ResolvedTenant): Set<string> {
  const value = String(process.env[tenant.binding.access.scheduleAdminUserIdsEnv] ?? "");
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}
