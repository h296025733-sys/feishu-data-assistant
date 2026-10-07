import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import {
  ContactDuplicateColorService,
  type ContactSnapshot,
} from "../feishu/contact-duplicate-colors.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const service = new ContactDuplicateColorService(env, client);
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const backupDirectory = resolve("backups", `contact-color-migration-${stamp}Z`);
const skipSubscribe = process.argv.includes("--skip-subscribe");

await mkdir(backupDirectory, { recursive: false });
const snapshot = await service.captureSnapshot();
await writeJson("CONTACT_FIELD_BEFORE.json", snapshot);

let result: unknown;
try {
  if (!skipSubscribe) {
    await service.subscribeToBaseEvents();
  }
  const installResult = await service.installFromSnapshot(snapshot);
  result = {
    completedAtUtc: new Date().toISOString(),
    backupDirectory,
    eventSubscription: skipSubscribe ? "preverified" : "subscribed",
    installResult,
  };
  await writeJson("INSTALL_RESULT.json", result);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  let rollback: unknown = null;
  try {
    rollback = await service.rollback(snapshot);
  } catch (rollbackError) {
    rollback = {
      failed: true,
      message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    };
  }
  result = {
    failedAtUtc: new Date().toISOString(),
    backupDirectory,
    error: message,
    automaticRollback: rollback,
  };
  await writeJson("INSTALL_FAILURE.json", result);
  throw new Error(`${message}；自动回滚结果：${JSON.stringify(rollback)}`);
}

console.log(JSON.stringify(result, null, 2));

async function writeJson(name: string, value: ContactSnapshot | unknown): Promise<void> {
  await writeFile(
    resolve(backupDirectory, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}
