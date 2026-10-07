import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);

try {
  const result = await client.im.file.create({
    data: {
      file_type: "stream",
      file_name: "TechWave-upload-diagnostic.csv",
      file: Buffer.from("\uFEFF商品,日期\r\nTechWave,2026-08-03\r\n", "utf8"),
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, fileKeyReturned: Boolean(result?.file_key) })}\n`);
} catch (error) {
  const value = error as {
    message?: unknown;
    code?: unknown;
    response?: { status?: unknown; data?: unknown; headers?: Record<string, unknown> };
  };
  const headers = value.response?.headers ?? {};
  process.stdout.write(`${JSON.stringify({
    ok: false,
    message: String(value.message ?? error),
    code: value.code ?? null,
    httpStatus: value.response?.status ?? null,
    responseData: value.response?.data ?? null,
    requestId: headers["x-tt-logid"] ?? headers["x-request-id"] ?? null,
  }, null, 2)}\n`);
  process.exitCode = 1;
}
