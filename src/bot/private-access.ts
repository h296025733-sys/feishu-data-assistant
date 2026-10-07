import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PrivateAccessCommand =
  | { kind: "list" }
  | { kind: "grant"; userId: string }
  | { kind: "revoke"; userId: string };

interface PrivateAccessState {
  members: string[];
}

export class PrivateAccessRegistry {
  private readonly bootstrapAdmins: Set<string>;
  private readonly runtimeMembers = new Set<string>();

  public constructor(
    bootstrapAdminIds: Iterable<string>,
    private readonly statePath: string,
  ) {
    this.bootstrapAdmins = new Set([...bootstrapAdminIds].map((item) => item.trim()).filter(Boolean));
    this.load();
  }

  public get size(): number {
    return this.all().length;
  }

  public has(userId: string): boolean {
    return this.bootstrapAdmins.has(userId) || this.runtimeMembers.has(userId);
  }

  public isAdmin(userId: string): boolean {
    return this.bootstrapAdmins.has(userId);
  }

  public all(): string[] {
    return [...new Set([...this.bootstrapAdmins, ...this.runtimeMembers])].sort();
  }

  public grant(userId: string): "added" | "existing" {
    assertOpenId(userId);
    if (this.has(userId)) return "existing";
    this.runtimeMembers.add(userId);
    this.persist();
    return "added";
  }

  public revoke(userId: string): "removed" | "missing" | "bootstrap_admin" {
    assertOpenId(userId);
    if (this.bootstrapAdmins.has(userId)) return "bootstrap_admin";
    if (!this.runtimeMembers.delete(userId)) return "missing";
    this.persist();
    return "removed";
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<PrivateAccessState>;
      for (const userId of parsed.members ?? []) {
        if (isOpenId(userId) && !this.bootstrapAdmins.has(userId)) this.runtimeMembers.add(userId);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new Error(`读取私聊权限文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ members: [...this.runtimeMembers].sort() }, null, 2)}\n`, "utf8");
    renameSync(temporary, this.statePath);
  }
}

export function parsePrivateAccessCommand(question: string): PrivateAccessCommand | null {
  const text = question.trim();
  if (/^(?:私聊权限名单|查看私聊权限|谁能私聊)$/.test(text)) return { kind: "list" };
  const grant = text.match(/^(?:授权私聊|添加私聊权限)\s+(ou_[A-Za-z0-9_-]+)$/i);
  if (grant) return { kind: "grant", userId: grant[1] };
  const revoke = text.match(/^(?:取消私聊权限|移除私聊权限)\s+(ou_[A-Za-z0-9_-]+)$/i);
  if (revoke) return { kind: "revoke", userId: revoke[1] };
  return null;
}

function assertOpenId(value: string): void {
  if (!isOpenId(value)) throw new Error("open_id 格式不正确，应以 ou_ 开头");
}

function isOpenId(value: unknown): value is string {
  return typeof value === "string" && /^ou_[A-Za-z0-9_-]+$/.test(value);
}
