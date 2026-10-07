import { getEnv } from "../config/env.js";

const env = getEnv();
if (!env.DEEPSEEK_API_KEY) throw new Error("缺少 DEEPSEEK_API_KEY");

try {
  const model = env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  const apiKey = env.DEEPSEEK_API_KEY.startsWith("sk-") ? env.DEEPSEEK_API_KEY : `sk-${env.DEEPSEEK_API_KEY}`;
  const response = await fetch(`${env.DEEPSEEK_BASE_URL.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "只回复 OK" }],
      thinking: { type: "disabled" },
      max_tokens: 8,
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text();
    let message = body.slice(0, 160);
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      message = parsed.error?.message ?? message;
    } catch {}
    throw new Error(`HTTP ${response.status}：${message}`);
  }
  const payload = await response.json() as { model?: string; usage?: { total_tokens?: number } };
  console.log(JSON.stringify({ DeepSeek认证: "成功", 模型: payload.model ?? model, 测试Token: payload.usage?.total_tokens ?? 0 }, null, 2));
} catch (error) {
  console.error(`DeepSeek 检查失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
