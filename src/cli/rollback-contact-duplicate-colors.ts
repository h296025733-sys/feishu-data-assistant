import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import {
  ContactDuplicateColorService,
  type ContactSnapshot,
} from "../feishu/contact-duplicate-colors.js";

const backupsRoot = resolve("backups");
const requested = process.argv[2];
const backupDirectory = requested ? resolve(requested) : await findLatestBackup();
const snapshotPath = resolve(backupDirectory, "CONTACT_FIELD_BEFORE.json");
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as ContactSnapshot;
const env = requireFeishuEnv(getEnv());
const service = new ContactDuplicateColorService(env, createFeishuClient(env));
const result = await service.rollback(snapshot);

const output = {
  completedAtUtc: new Date().toISOString(),
  backupDirectory,
  ...result,
};
await writeFile(
  resolve(backupDirectory, "ROLLBACK_RESULT.json"),
  `${JSON.stringify(output, null, 2)}\n`,
  { encoding: "utf8", flag: "wx" },
);
console.log(JSON.stringify(output, null, 2));

async function findLatestBackup(): Promise<string> {
  const names = (await readdir(backupsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("contact-color-migration-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  if (names.length === 0) throw new Error("没有找到联系方式显色迁移备份。");
  return resolve(backupsRoot, names[0]);
}
