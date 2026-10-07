import {
  formatRoiPreview,
  prepareRoiUpdatePlan,
} from "../realtime/roi-sync.js";

try {
  const date = argument("--date");
  const productName = argument("--product");
  const plan = await prepareRoiUpdatePlan({
    jobId: "rt-20000101000000-00000000",
    startDate: date,
    endDateInclusive: date,
    productName,
  });
  process.stdout.write(`${formatRoiPreview(plan)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`投产比预览失败：${message}\n`);
  process.exitCode = 1;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}
