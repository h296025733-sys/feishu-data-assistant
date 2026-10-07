import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const tenant = new TenantRegistry(getEnv()).byId("storetwo-formal");
if (!tenant) throw new Error("Storetwo formal tenant missing");
const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
const tableId = "demo_50d59a7d";
const recordId = "demo_c29dc477";
const imagePath = path.resolve(".runtime/cooperation-avatar/formidablyfrugal.jpeg");
const image = await readFile(imagePath);
if (image.length < 10_000 || image[0] !== 0xff || image[1] !== 0xd8) throw new Error("Invalid JPEG sample");
const client = createFeishuClient(tenant.env);
const tablePath = { app_token: appToken, table_id: tableId };
const fields = await client.bitable.appTableField.list({ path: tablePath, params: { page_size: 100 } });
assertFeishuResponse(fields, "Avatar sample field list");
const names = fields.data?.items ?? [];
const avatar = names.find((field) => field.field_name === "红人头像");
const nameIndex = names.findIndex((field) => field.field_name === "红人姓名");
if (!avatar || avatar.type !== 17 || names[nameIndex - 1]?.field_id !== avatar.field_id) {
  throw new Error(`Avatar schema/position mismatch: avatar=${avatar?.type}, left=${names[nameIndex - 1]?.field_name}`);
}
const recordPath = { ...tablePath, record_id: recordId };
const before = await client.bitable.appTableRecord.get({ path: recordPath });
assertFeishuResponse(before, "Avatar sample record before");
if (before.data?.record?.fields?.红人姓名 !== "formidablyfrugal") throw new Error("Sample creator changed");
if (before.data?.record?.fields?.红人头像) throw new Error("Sample avatar already populated; refuse overwrite");
const upload = await client.drive.media.uploadAll({ data: {
  file_name: "formidablyfrugal.jpeg", parent_type: "bitable_image", parent_node: appToken,
  size: image.length, file: image,
} });
const uploadRecord = upload as Record<string, any> | null;
const fileToken = uploadRecord?.file_token ?? uploadRecord?.data?.file_token;
if (uploadRecord?.code && uploadRecord.code !== 0 || !fileToken) {
  throw new Error(`Avatar upload failed: code=${uploadRecord?.code}, keys=${Object.keys(uploadRecord ?? {}).join(",")}`);
}
const updated = await client.bitable.appTableRecord.update({ path: recordPath, data: {
  fields: { 红人头像: [{ file_token: fileToken }] },
} });
assertFeishuResponse(updated, "Avatar sample record update");
const after = await client.bitable.appTableRecord.get({ path: recordPath });
assertFeishuResponse(after, "Avatar sample record readback");
const actual = after.data?.record?.fields?.红人头像;
if (!Array.isArray(actual) || actual.length !== 1 || (actual[0] as any)?.file_token !== fileToken) {
  throw new Error("Avatar attachment readback mismatch");
}
for (const [key, value] of Object.entries(before.data?.record?.fields ?? {})) {
  if (key === "红人头像") continue;
  if (JSON.stringify(after.data?.record?.fields?.[key]) !== JSON.stringify(value)) {
    throw new Error(`Protected field changed: ${key}`);
  }
}
console.log(JSON.stringify({ tenant: tenant.binding.id, tableId, recordId,
  fieldId: avatar.field_id, bytes: image.length, attachmentCount: actual.length,
  position: `${names[nameIndex - 1]?.field_name} -> 红人姓名`, protectedFieldsUnchanged: true }));
