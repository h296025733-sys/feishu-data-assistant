import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const settingsSchema = z.object({
  version: z.literal(1),
  dailyAutomation: z.object({
    enabled: z.boolean(),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }),
  updatedAt: z.string(),
  updatedBy: z.string().trim().min(1),
});

export type TenantRuntimeSettings = z.infer<typeof settingsSchema>;

export async function readTenantRuntimeSettings(
  tenantId: string,
): Promise<TenantRuntimeSettings | null> {
  try {
    const parsed = settingsSchema.safeParse(
      JSON.parse(await readFile(runtimeSettingsPath(tenantId), "utf8")),
    );
    if (!parsed.success) {
      throw new Error(`店铺 ${tenantId} 的运行设置无效：${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeTenantRuntimeSettings(
  tenantId: string,
  input: { enabled: boolean; localTime: string; updatedBy: string },
): Promise<TenantRuntimeSettings> {
  const settings = settingsSchema.parse({
    version: 1,
    dailyAutomation: { enabled: input.enabled, localTime: input.localTime },
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy,
  });
  const target = runtimeSettingsPath(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  return settings;
}

function runtimeSettingsPath(tenantId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(tenantId)) {
    throw new Error(`店铺租户ID无效：${tenantId}`);
  }
  return path.resolve(".runtime", "tenants", tenantId, "settings.json");
}
