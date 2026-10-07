import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/config/env.js";
import type { BitableRecordChangeEvent } from "../src/feishu/contact-duplicate-index.js";
import { registerTrustedOnlineImport } from "../src/feishu/online-date-trusted-imports.js";
import {
  OnlineLaunchDateGuardService,
  eventTimestampMs,
  isAdminEvent,
  shanghaiDayStartMs,
} from "../src/feishu/online-date-guard.js";

const TABLE_ID = "tbl_online";
const FIELD_ID = "fld_launch_date";
const FIELD_NAME = "实上线日期(Ct)";
const JULY_30 = Date.parse("2026-07-29T16:00:00.000Z");
const JULY_31 = Date.parse("2026-07-30T16:00:00.000Z");
const AUGUST_1 = Date.parse("2026-07-31T16:00:00.000Z");
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("online launch date guard helpers", () => {
  it("uses Shanghai midnight and supports second timestamps", () => {
    expect(shanghaiDayStartMs(Date.parse("2026-07-31T09:00:00.000Z"))).toBe(JULY_31);
    expect(eventTimestampMs({ update_time: 1_785_469_200 })).toBe(1_785_469_200_000);
  });

  it("matches any Feishu operator id against the admin allowlist", () => {
    const event = { operator_id: { open_id: "ou_admin", user_id: "u_admin" } };
    expect(isAdminEvent(event, new Set(["ou_admin"]))).toBe(true);
    expect(isAdminEvent(event, new Set(["ou_other"]))).toBe(false);
  });
});

describe("OnlineLaunchDateGuardService", () => {
  it("accepts a verified offline import at restart but still rejects a different ordinary edit", async () => {
    const harness = await createHarness({ rec1: JULY_31 }, { rec1: JULY_30 });
    await registerTrustedOnlineImport("rec1", JULY_31, { path: harness.trustedPath });
    expect((await harness.service.start()).driftedRecords).toBe(0);
    harness.records.set("rec1", AUGUST_1);
    harness.service.handleRecordChanged(changeEvent("ou_member", "rec1", "record_edited"));
    await harness.service.waitForIdle();
    expect(harness.records.get("rec1")).toBe(JULY_31);
  });
  it("reverts an ordinary user's edit to the trusted date", async () => {
    const harness = await createHarness({ rec1: JULY_30 });
    await harness.service.start();
    harness.records.set("rec1", AUGUST_1);

    harness.service.handleRecordChanged(changeEvent("ou_member", "rec1", "record_edited"));
    await harness.service.waitForIdle();

    expect(harness.records.get("rec1")).toBe(JULY_30);
    expect(harness.updates).toEqual([{ recordId: "rec1", value: JULY_30 }]);
  });

  it("accepts an allowlisted administrator's correction", async () => {
    const harness = await createHarness({ rec1: JULY_30 });
    await harness.service.start();
    harness.records.set("rec1", JULY_31);

    harness.service.handleRecordChanged(changeEvent("ou_admin", "rec1", "record_edited"));
    await harness.service.waitForIdle();

    expect(harness.records.get("rec1")).toBe(JULY_31);
    expect(harness.updates).toEqual([]);
  });

  it("forces a newly added ordinary record to the event's Shanghai day", async () => {
    const harness = await createHarness({});
    await harness.service.start();
    harness.records.set("rec_new", JULY_30);
    const event = changeEvent("ou_member", "rec_new", "record_added");
    event.update_time = Date.parse("2026-07-31T09:00:00.000Z");

    harness.service.handleRecordChanged(event);
    await harness.service.waitForIdle();

    expect(harness.records.get("rec_new")).toBe(JULY_31);
    expect(harness.updates).toEqual([{ recordId: "rec_new", value: JULY_31 }]);
  });

  it("clears a stale baseline for an empty placeholder and protects its first fill", async () => {
    const harness = await createHarness({ rec1: null }, { rec1: JULY_30 });
    const started = await harness.service.start();
    expect(started.driftedRecords).toBe(0);

    harness.records.set("rec1", AUGUST_1);
    harness.service.handleRecordChanged(changeEvent("ou_member", "rec1", "record_edited"));
    await harness.service.waitForIdle();
    expect(harness.records.get("rec1")).toBe(AUGUST_1);
    expect(harness.updates).toEqual([]);

    harness.records.set("rec1", JULY_30);
    harness.service.handleRecordChanged(changeEvent("ou_member", "rec1", "record_edited"));
    await harness.service.waitForIdle();
    expect(harness.records.get("rec1")).toBe(AUGUST_1);
    expect(harness.updates).toEqual([{ recordId: "rec1", value: AUGUST_1 }]);
  });

  it("does not touch another table", async () => {
    const harness = await createHarness({ rec1: JULY_30 });
    await harness.service.start();
    harness.records.set("rec1", AUGUST_1);
    const event = changeEvent("ou_member", "rec1", "record_edited");
    event.table_id = "tbl_other";

    harness.service.handleRecordChanged(event);
    await harness.service.waitForIdle();

    expect(harness.records.get("rec1")).toBe(AUGUST_1);
    expect(harness.updates).toEqual([]);
  });
});

async function createHarness(
  initial: Record<string, number | null>,
  stored?: Record<string, number | null>,
) {
  const directory = await mkdtemp(join(tmpdir(), "online-date-guard-"));
  tempDirectories.push(directory);
  const statePath = join(directory, "state.json");
  const trustedPath = join(directory, "trusted.json");
  if (stored) {
    await writeFile(statePath, JSON.stringify({
      version: 1,
      tableId: TABLE_ID,
      fieldId: FIELD_ID,
      updatedAt: new Date(0).toISOString(),
      records: stored,
    }), "utf8");
  }
  const records = new Map(Object.entries(initial));
  const updates: Array<{ recordId: string; value: number | null }> = [];
  const client = {
    bitable: {
      appTable: {
        list: async () => ({
          code: 0,
          data: { items: [{ table_id: TABLE_ID, name: "Tech-wave红人上线表" }] },
        }),
      },
      appTableField: {
        list: async () => ({
          code: 0,
          data: {
            items: [{ field_id: FIELD_ID, field_name: FIELD_NAME, type: 5 }],
          },
        }),
      },
      appTableRecord: {
        list: async () => ({
          code: 0,
          data: {
            items: [...records].map(([recordId, date]) => ({
              record_id: recordId,
              fields: { [FIELD_NAME]: date },
            })),
          },
        }),
        get: async ({ path }: { path: { record_id: string } }) => ({
          code: 0,
          data: {
            record: {
              record_id: path.record_id,
              fields: { [FIELD_NAME]: records.get(path.record_id) ?? null },
            },
          },
        }),
        update: async ({
          path,
          data,
        }: {
          path: { record_id: string };
          data: { fields: Record<string, unknown> };
        }) => {
          const value = data.fields[FIELD_NAME] as number | null;
          records.set(path.record_id, value);
          updates.push({ recordId: path.record_id, value });
          return { code: 0 };
        },
      },
    },
  };
  const env = {
    FEISHU_BITABLE_APP_TOKEN: "app_token",
  } as AppEnv;
  const service = new OnlineLaunchDateGuardService(
    env,
    client as never,
    new Set(["ou_admin"]),
    statePath,
    undefined,
    trustedPath,
  );
  return { service, records, updates, trustedPath };
}

function changeEvent(
  operator: string,
  recordId: string,
  action: string,
): BitableRecordChangeEvent {
  return {
    event_id: `evt_${recordId}_${action}`,
    table_id: TABLE_ID,
    operator_id: { open_id: operator },
    action_list: [{
      record_id: recordId,
      action,
      before_value: [{ field_id: FIELD_ID, field_value: String(JULY_30) }],
      after_value: [{ field_id: FIELD_ID, field_value: String(AUGUST_1) }],
    }],
  };
}
