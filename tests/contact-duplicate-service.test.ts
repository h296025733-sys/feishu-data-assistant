import type { Client } from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/config/env.js";
import {
  CONTACT_FIELD_NAME,
  DUPLICATE_CONTACT_COLOR,
  UNIQUE_CONTACT_COLOR,
  ContactDuplicateColorService,
} from "../src/feishu/contact-duplicate-colors.js";

describe("ContactDuplicateColorService incremental queue", () => {
  it("coalesces 100 concurrent events into one batch and one metadata write", async () => {
    const env = fakeEnv();
    const records = new Map<string, string>([["seed", "same@example.com"]]);
    let field = {
      field_id: "contact-field",
      field_name: CONTACT_FIELD_NAME,
      type: 3,
      ui_type: "SingleSelect",
      is_hidden: false,
      property: {
        options: [{
          id: "same-option",
          name: "same@example.com",
          color: UNIQUE_CONTACT_COLOR,
        }],
      },
    };
    const batchGetSizes: number[] = [];
    let fieldUpdates = 0;

    const client = {
      bitable: {
        appTableField: {
          list: async () => ({
            code: 0,
            data: { items: [structuredClone(field)], has_more: false },
          }),
          update: async (payload: {
            data: { property?: { options?: typeof field.property.options } };
          }) => {
            fieldUpdates += 1;
            field = {
              ...field,
              property: {
                options: structuredClone(payload.data.property?.options ?? []),
              },
            };
            return { code: 0 };
          },
        },
        appTableRecord: {
          list: async () => ({
            code: 0,
            data: {
              items: [...records].map(([recordId, value]) => ({
                record_id: recordId,
                fields: { [CONTACT_FIELD_NAME]: value },
              })),
              has_more: false,
            },
          }),
          batchGet: async (payload: { data: { record_ids: string[] } }) => {
            batchGetSizes.push(payload.data.record_ids.length);
            const found = payload.data.record_ids.filter((recordId) => records.has(recordId));
            return {
              code: 0,
              data: {
                records: found.map((recordId) => ({
                  record_id: recordId,
                  fields: { [CONTACT_FIELD_NAME]: records.get(recordId) ?? "" },
                })),
                absent_record_ids: payload.data.record_ids.filter((recordId) => !records.has(recordId)),
                forbidden_record_ids: [],
              },
            };
          },
        },
      },
    } as unknown as Client;

    const service = new ContactDuplicateColorService(env, client);
    await service.sync("test_startup");

    for (let index = 0; index < 100; index += 1) {
      const recordId = `new-${index}`;
      records.set(recordId, "same@example.com");
      service.handleRecordChanged({
        file_token: env.FEISHU_BITABLE_APP_TOKEN,
        table_id: env.FEISHU_BITABLE_TABLE_ID,
        action_list: [{
          record_id: recordId,
          action: "record_added",
          after_value: [{
            field_id: "contact-field",
            field_value: "same@example.com",
          }],
        }],
      });
    }

    await service.waitForIdle(5_000);
    expect(batchGetSizes).toEqual([100]);
    expect(fieldUpdates).toBe(1);
    expect(field.property.options).toContainEqual({
      id: "same-option",
      name: "same@example.com",
      color: DUPLICATE_CONTACT_COLOR,
    });
  });

  it("re-reads and preserves user-created options after a write conflict", async () => {
    const env = fakeEnv();
    const records = new Map<string, string>([["seed", "same@example.com"]]);
    let field = {
      field_id: "contact-field",
      field_name: CONTACT_FIELD_NAME,
      type: 3,
      ui_type: "SingleSelect",
      is_hidden: false,
      property: {
        options: [{
          id: "same-option",
          name: "same@example.com",
          color: UNIQUE_CONTACT_COLOR,
        }],
      },
    };
    let fieldUpdates = 0;

    const client = {
      bitable: {
        appTableField: {
          list: async () => ({
            code: 0,
            data: { items: [structuredClone(field)], has_more: false },
          }),
          update: async (payload: {
            data: { property?: { options?: typeof field.property.options } };
          }) => {
            fieldUpdates += 1;
            if (fieldUpdates === 1) {
              field.property.options.push({
                id: "concurrent-option",
                name: "concurrent@example.com",
                color: 7,
              });
              return { code: 1254291, msg: "LockNotObtainedError" };
            }
            field = {
              ...field,
              property: {
                options: structuredClone(payload.data.property?.options ?? []),
              },
            };
            return { code: 0 };
          },
        },
        appTableRecord: {
          list: async () => ({
            code: 0,
            data: {
              items: [...records].map(([recordId, value]) => ({
                record_id: recordId,
                fields: { [CONTACT_FIELD_NAME]: value },
              })),
              has_more: false,
            },
          }),
          batchGet: async (payload: { data: { record_ids: string[] } }) => ({
            code: 0,
            data: {
              records: payload.data.record_ids.map((recordId) => ({
                record_id: recordId,
                fields: { [CONTACT_FIELD_NAME]: records.get(recordId) ?? "" },
              })),
              absent_record_ids: [],
              forbidden_record_ids: [],
            },
          }),
        },
      },
    } as unknown as Client;

    const service = new ContactDuplicateColorService(env, client);
    await service.sync("test_startup");
    records.set("second", "same@example.com");
    service.handleRecordChanged({
      file_token: env.FEISHU_BITABLE_APP_TOKEN,
      table_id: env.FEISHU_BITABLE_TABLE_ID,
      action_list: [{
        record_id: "second",
        action: "record_added",
        after_value: [{
          field_id: "contact-field",
          field_value: "same@example.com",
        }],
      }],
    });

    await service.waitForIdle(5_000);
    expect(fieldUpdates).toBe(2);
    expect(field.property.options).toContainEqual({
      id: "concurrent-option",
      name: "concurrent@example.com",
      color: 7,
    });
    expect(field.property.options).toContainEqual({
      id: "same-option",
      name: "same@example.com",
      color: DUPLICATE_CONTACT_COLOR,
    });
  });
});

function fakeEnv(): AppEnv {
  return {
    FEISHU_APP_ID: "app",
    FEISHU_APP_SECRET: "secret",
    FEISHU_BITABLE_URL: "",
    FEISHU_BITABLE_APP_TOKEN: "base",
    FEISHU_BITABLE_TABLE_ID: "table",
    BOT_ALLOWED_USER_IDS: "user",
    MODEL_PROVIDER: "mock",
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "",
    DRY_RUN: "true",
    LOG_LEVEL: "error",
    DEEPSEEK_INPUT_PRICE_PER_MILLION: 0,
    DEEPSEEK_OUTPUT_PRICE_PER_MILLION: 0,
  };
}
