import { describe, expect, it } from "vitest";
import { formatFeishuFileUploadError } from "../src/feishu/file-upload-error.js";

describe("Feishu file upload diagnostics", () => {
  it("turns missing-scope HTTP 400 into an actionable permission message", () => {
    const text = formatFeishuFileUploadError({
      message: "Request failed with status code 400",
      response: {
        status: 400,
        data: {
          code: 99991672,
          msg: "Access denied",
          error: { log_id: "log-123" },
        },
      },
    });
    expect(text).toContain("im:resource:upload");
    expect(text).toContain("CSV尚未上传");
    expect(text).toContain("log-123");
  });
});
