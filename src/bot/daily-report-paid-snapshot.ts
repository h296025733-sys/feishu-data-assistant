import type { BusinessProfile } from "../config/business-profile.js";
import { prepareOrderAttributionUpdatePlan } from "../realtime/roi-sync.js";
import type { DailyReportPaidProductSnapshot } from "./daily-group-report.js";

/**
 * Read-only fallback for the report's current paid orders, items and sales.
 * It uses the exact shop-local day requested by the report and never writes Feishu.
 */
export async function loadDailyReportPaidSnapshot(
  profile: BusinessProfile,
  reportDate: string,
): Promise<DailyReportPaidProductSnapshot[]> {
  const plan = await prepareOrderAttributionUpdatePlan({
    startDate: reportDate,
    endDateInclusive: reportDate,
    profile,
  });
  return plan.paidSnapshotEntries.flatMap((entry) => entry.sources
    .filter((source) => source.date === reportDate)
    .map((source) => ({
      date: source.date,
      name: entry.product.name,
      orders: source.orders,
      items: source.items,
      sales: source.sales ?? null,
    })));
}
