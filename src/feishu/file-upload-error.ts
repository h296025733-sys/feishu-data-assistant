export function formatFeishuFileUploadError(error: unknown): string {
  const value = error as {
    message?: unknown;
    response?: {
      status?: unknown;
      data?: {
        code?: unknown;
        msg?: unknown;
        error?: { log_id?: unknown };
      };
    };
  };
  const data = value?.response?.data;
  const code = Number(data?.code ?? 0);
  const logId = String(data?.error?.log_id ?? "").trim();
  if (code === 99991672) {
    return [
      "机器人应用缺少飞书文件上传权限 im:resource:upload，CSV尚未上传。",
      "请在飞书开发者后台为机器人应用开通该权限；开通生效后重新发送原导出命令即可。",
      logId ? `飞书日志ID：${logId}` : null,
    ].filter(Boolean).join(" ");
  }
  const message = String(data?.msg ?? value?.message ?? error).replace(/https?:\/\/\S+/g, "[链接已省略]");
  return [
    code ? `飞书错误码${code}` : null,
    message || `HTTP ${String(value?.response?.status ?? "未知")}`,
    logId ? `日志ID：${logId}` : null,
  ].filter(Boolean).join("；").slice(0, 1_000);
}
