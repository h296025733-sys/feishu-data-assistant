import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { loadBusinessProfileFile } from "../config/business-profile.js";
import { prepareLatestAccountSidePlan, type AccountSidePlan } from "../account-side/plan.js";
import {
  type AccountSideTestBase,
  assertTestEnterpriseEnv,
  auditAccountSideBase,
  installAccountSideSchemaInExistingBase,
  syncAccountSidePlanToBase,
  verifyAccountSideBase,
} from "../feishu/account-side-test.js";

const PROJECT_ROOT = process.cwd();
const REPORT_ROOT = path.join(PROJECT_ROOT, ".runtime", "account-side-test");
const STOREONE_PROFILE = path.join(PROJECT_ROOT, "config", "tenants", "storeone-formal.profile.json");
const PLAN_FILE = path.join(REPORT_ROOT, "storeone-seven-complete-days-plan.json");
const RESULT_FILE = path.join(REPORT_ROOT, "last-result.json");

const args = process.argv.slice(2).filter((value) => value !== "--");
const action = args.find((value) => value.startsWith("--") && !["--apply", "--confirm"].includes(value)) ?? "--audit-source";
const env = requireFeishuEnv(getEnv());
assertTestEnterpriseEnv(env);

let result: Record<string, unknown>;
switch (action) {
  case "--audit-source":
    result = {
      action: "audit-source",
      evidence: "real-feishu-api-read-only",
      checkedAt: new Date().toISOString(),
      base: await auditAccountSideBase(env),
    };
    break;
  case "--prepare-storeone": {
    const plan = await prepareStoreonePlan();
    await writeJsonAtomic(PLAN_FILE, plan);
    result = summarizePlan(plan, "real-tiktok-api-read-only");
    break;
  }
  case "--provision":
    throw new Error("已按用户要求禁用复制/新建测试Base；账号端只能接入.env.test.local指向的既有测试Base");
  case "--install-schema": {
    requireWriteConfirmation("ACCOUNT-SIDE-EXISTING-TEST-BASE-SCHEMA");
    const base = currentExistingTestBase();
    result = {
      action: "install-schema",
      evidence: "real-feishu-test-enterprise-write-and-readback",
      target: { name: base.name, url: base.url },
      schema: await installAccountSideSchemaInExistingBase(env, base),
    };
    break;
  }
  case "--sync-storeone": {
    requireWriteConfirmation("ACCOUNT-SIDE-EXISTING-TEST-BASE-STOREONE-SEVEN-DAYS");
    const base = currentExistingTestBase();
    const plan = await prepareStoreonePlan();
    await writeJsonAtomic(PLAN_FILE, plan);
    const first = await syncAccountSidePlanToBase(env, base, plan);
    const second = await syncAccountSidePlanToBase(env, base, plan);
    result = {
      action: "sync-storeone",
      evidence: "real-tiktok-api-read-plus-real-feishu-test-enterprise-write-readback",
      plan: summarizePlan(plan, "real-tiktok-api-read-only"),
      first,
      idempotentReplay: second,
    };
    break;
  }
  case "--verify": {
    const base = currentExistingTestBase();
    const plan = await loadSavedPlan();
    result = {
      action: "verify",
      evidence: "real-feishu-test-enterprise-read-only-against-saved-real-tiktok-plan",
      checkedAt: new Date().toISOString(),
      target: { name: base.name, url: base.url },
      plan: summarizePlan(plan, "saved-real-tiktok-api-read-only-plan"),
      verification: await verifyAccountSideBase(env, base, plan),
    };
    break;
  }
  default:
    throw new Error(`未知操作：${action}`);
}

await writeJsonAtomic(RESULT_FILE, result);
console.log(JSON.stringify(result, null, 2));

async function prepareStoreonePlan(): Promise<AccountSidePlan> {
  const profile = loadBusinessProfileFile(STOREONE_PROFILE);
  return prepareLatestAccountSidePlan({ profile, days: 7 });
}

async function loadSavedPlan(): Promise<AccountSidePlan> {
  try {
    return JSON.parse(await readFile(PLAN_FILE, "utf8")) as AccountSidePlan;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("尚无STOREONE账号端验证计划；请先运行 --prepare-storeone 或 --sync-storeone");
    }
    throw error;
  }
}

function currentExistingTestBase(): AccountSideTestBase {
  return {
    storeKey: "storeone",
    storeName: "STOREONE",
    appToken: env.FEISHU_BITABLE_APP_TOKEN,
    name: "店铺经营工作台模板",
    url: env.FEISHU_BITABLE_URL,
    createdAt: "existing-test-base",
  };
}

function requireWriteConfirmation(expected: string): void {
  const apply = args.includes("--apply");
  const position = args.indexOf("--confirm");
  const actual = position >= 0 ? args[position + 1] : "";
  if (!apply || actual !== expected) {
    throw new Error(`这是测试企业写入操作；必须同时提供 --apply --confirm ${expected}`);
  }
}

function summarizePlan(plan: AccountSidePlan, evidence: string): Record<string, unknown> {
  return {
    action: "prepare-storeone",
    evidence,
    generatedAt: plan.generatedAt,
    shop: plan.shop,
    sourceDateSemantics: "TikTok店铺注册时区的完整经营日；飞书日期字段按Asia/Shanghai显示同一日历日期标签",
    latestAvailableDate: plan.latestAvailableDate,
    range: { start: plan.startDate, endInclusive: plan.endDateInclusive, days: plan.dates.length },
    counts: {
      accounts: plan.accounts.length,
      recentVideoProductRows: plan.videos.length,
      productRoiRows: plan.productRows.length,
      accountRoiRows: plan.accountRows.length,
    },
    requestIds: plan.requestIds,
    rawSourceFileCount: plan.sourceFiles.length,
    warnings: plan.warnings,
    planFile: PLAN_FILE,
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}
