import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalIntent, hashText } from "./intent.js";
import type { RealtimeIntent, RealtimeJob, RealtimeJobStatus, RealtimeResultSummary } from "./types.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export class RealtimeJobStore {
  public readonly root: string;

  public constructor(root = path.join(PROJECT_ROOT, ".runtime", "realtime-sync", "jobs")) {
    this.root = root;
  }

  public async createOrReuse(input: {
    userId: string;
    messageId: string;
    intent: RealtimeIntent;
  }): Promise<{ job: RealtimeJob; reused: boolean }> {
    await mkdir(this.root, { recursive: true });
    const canonical = canonicalIntent(input.intent);
    const idempotencyKey = hashText(`${input.messageId}\n${canonical}`);
    const taskKey = hashText(canonical);
    const userIdHash = hashUserId(input.userId);
    const existing = await this.list();
    const sameMessage = existing.find((job) => job.idempotencyKey === idempotencyKey);
    if (sameMessage) return { job: sameMessage, reused: true };
    // 删除属于破坏性操作：只允许按同一条飞书消息幂等，不能把以后再次删除同名商品
    // 误判成已完成的旧任务。普通更新仍可复用相同用户的成功语义任务。
    const sameTask = input.intent.action === "delete_roi_product"
      ? undefined
      : existing
        .filter((job) => (
          job.userIdHash === userIdHash
          && job.taskKey === taskKey
          && job.status === "succeeded"
        ))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (sameTask) return { job: sameTask, reused: true };

    const now = new Date().toISOString();
    const job: RealtimeJob = {
      version: 1,
      jobId: `rt-${now.replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      userIdHash,
      messageId: input.messageId,
      idempotencyKey,
      taskKey,
      intent: input.intent,
      status: "received",
      createdAt: now,
      updatedAt: now,
      missingItems: [],
      prompt: null,
      resultSummary: null,
      error: null,
      rollbackPreview: null,
      rollbackResult: null,
    };
    await this.save(job);
    return { job, reused: false };
  }

  public async get(jobId: string): Promise<RealtimeJob | null> {
    try {
      return JSON.parse(await readFile(this.jobPath(jobId), "utf8")) as RealtimeJob;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  public async latestForUser(userId: string): Promise<RealtimeJob | null> {
    const userIdHash = hashUserId(userId);
    return (await this.list())
      .filter((job) => job.userIdHash === userIdHash)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  public async getForUser(jobId: string, userId: string): Promise<RealtimeJob | null> {
    if (!/^rt-\d{14}-[a-f0-9]{8}$/.test(jobId)) return null;
    const job = await this.get(jobId);
    return job?.userIdHash === hashUserId(userId) ? job : null;
  }

  public async update(
    job: RealtimeJob,
    patch: Partial<Pick<
      RealtimeJob,
      "status" | "missingItems" | "prompt" | "resultSummary" | "error" | "rollbackPreview" | "rollbackResult"
    >>,
  ): Promise<RealtimeJob> {
    const updated: RealtimeJob = { ...job, ...patch, updatedAt: new Date().toISOString() };
    await this.save(updated);
    return updated;
  }

  public async setStatus(job: RealtimeJob, status: RealtimeJobStatus): Promise<RealtimeJob> {
    return this.update(job, { status });
  }

  public async setResult(job: RealtimeJob, resultSummary: RealtimeResultSummary): Promise<RealtimeJob> {
    return this.update(job, { status: "succeeded", resultSummary, missingItems: resultSummary.missingItems });
  }

  public jobDirectory(jobId: string): string {
    return path.join(this.root, safeJobId(jobId));
  }

  private jobPath(jobId: string): string {
    return path.join(this.jobDirectory(jobId), "job.json");
  }

  private async save(job: RealtimeJob): Promise<void> {
    const directory = this.jobDirectory(job.jobId);
    await mkdir(directory, { recursive: true });
    const target = this.jobPath(job.jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private async list(): Promise<RealtimeJob[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const jobs: RealtimeJob[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await this.get(entry.name);
      if (job) jobs.push(job);
    }
    return jobs;
  }
}

function safeJobId(jobId: string): string {
  if (!/^rt-\d{14}-[a-f0-9]{8}$/.test(jobId)) throw new Error("job_id 格式无效");
  return jobId;
}

export function hashUserId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 16);
}
