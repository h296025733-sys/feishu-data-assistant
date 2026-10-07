import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const schema = z.object({
  schemaVersion: z.literal(1),
  templateMode: z.boolean().optional().default(false),
  businessDisplayName: z.string().trim().min(1),
  businessTimeZone: z.string().trim().min(1).refine(isTimeZone, "必须是有效的IANA时区"),
  storeAggregateLabel: z.string().trim().min(1),
  cooperationDateField: z.string().trim().min(1).optional(),
  tables: z.object({
    development: z.string().trim().min(1),
    cooperation: z.string().trim().min(1),
    online: z.string().trim().min(1),
    roi: z.string().trim().min(1),
  }),
  tiktok: z.object({
    shopAlias: z.string().trim().min(1),
    shopId: z.string().trim().optional(),
    credentialProfile: z.string().trim().min(1).optional(),
    shopTimeZone: z.string().trim().min(1).refine(isTimeZone, "必须是有效的IANA时区"),
    currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "必须是三位ISO货币代码").optional(),
    productMapFile: z.string().trim().min(1),
    includedCanonicalProducts: z.array(z.string().trim().min(1)).min(1).optional(),
    autoEnrollNewProducts: z.boolean().default(false),
    roiDateBasis: z.enum(["shop_registered", "business"]).default("shop_registered"),
    orderAttribution: z.object({
      enabled: z.boolean(),
      affiliateNonLiveAsVideo: z.boolean().default(false),
      targetCollaborationIsSelfOperated: z.boolean().optional(),
      reconciliationDays: z.number().int().min(1).max(7).default(3),
    }).optional(),
  }),
  advertising: z.object({
    spendFieldName: z.string().trim().min(1),
    orderFieldName: z.string().trim().min(1),
  }).optional(),
  dailyAutomation: z.object({
    enabled: z.boolean(),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "必须是HH:mm"),
    reportLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "必须是HH:mm").optional(),
    reportPreparationLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "必须是HH:mm").optional(),
    catchUpLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "必须是HH:mm").optional(),
    integrationStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "必须是YYYY-MM-DD"),
    reconciliationDays: z.number().int().min(1).max(14),
    probeDays: z.number().int().min(3).max(31),
    runOnStartup: z.boolean(),
  }).optional(),
  accountSideAutomation: z.object({
    enabled: z.boolean(),
    reconciliationDays: z.number().int().min(1).max(31).default(7),
  }).optional(),
  productSpikeMonitor: z.object({
    enabled: z.boolean(),
    pollMinutes: z.number().int().min(2).max(30).default(5),
  }).optional(),
});

export type BusinessProfile = z.input<typeof schema>;

const cached = new Map<string, BusinessProfile>();

export function loadBusinessProfile(): BusinessProfile {
  const configured = String(process.env.BUSINESS_PROFILE_FILE ?? (existsSync("config/business-profile.json") ? "config/business-profile.json" : "config/business-profile.example.json")).trim();
  return loadBusinessProfileFile(configured);
}

export function loadBusinessProfileFile(configured: string): BusinessProfile {
  const profilePath = path.resolve(process.cwd(), configured);
  const existing = cached.get(profilePath);
  if (existing) return existing;
  const parsed = schema.safeParse(JSON.parse(readFileSync(profilePath, "utf8")));
  if (!parsed.success) {
    throw new Error(`业务配置无效（${profilePath}）：${z.prettifyError(parsed.error)}`);
  }
  cached.set(profilePath, parsed.data);
  return parsed.data;
}

export function clearBusinessProfileCacheForTests(): void {
  cached.clear();
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
