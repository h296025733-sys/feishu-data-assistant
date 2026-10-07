interface PendingTask<T> {
  tenantId: string;
  limit: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** FIFO admission with independent per-store and global limits. */
export class TenantQueryExecutor {
  private readonly queue: PendingTask<unknown>[] = [];
  private readonly activeByTenant = new Map<string, number>();
  private activeGlobal = 0;

  public constructor(private readonly globalLimit: number) {
    if (!Number.isInteger(globalLimit) || globalLimit < 1) {
      throw new Error("全局查询并发数必须是正整数");
    }
  }

  public run<T>(tenantId: string, tenantLimit: number, task: () => Promise<T>): Promise<T> {
    if (!Number.isInteger(tenantLimit) || tenantLimit < 1) {
      return Promise.reject(new Error("店铺查询并发数必须是正整数"));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        tenantId,
        limit: tenantLimit,
        run: task,
        resolve,
        reject,
      } as PendingTask<unknown>);
      this.dispatch();
    });
  }

  public snapshot(): { activeGlobal: number; queued: number; activeByTenant: Record<string, number> } {
    return {
      activeGlobal: this.activeGlobal,
      queued: this.queue.length,
      activeByTenant: Object.fromEntries(this.activeByTenant),
    };
  }

  private dispatch(): void {
    while (this.activeGlobal < this.globalLimit) {
      const index = this.queue.findIndex((task) => (
        (this.activeByTenant.get(task.tenantId) ?? 0) < task.limit
      ));
      if (index < 0) return;
      const [task] = this.queue.splice(index, 1);
      this.activeGlobal += 1;
      this.activeByTenant.set(
        task.tenantId,
        (this.activeByTenant.get(task.tenantId) ?? 0) + 1,
      );
      void task.run().then(task.resolve, task.reject).finally(() => {
        this.activeGlobal -= 1;
        const active = (this.activeByTenant.get(task.tenantId) ?? 1) - 1;
        if (active <= 0) this.activeByTenant.delete(task.tenantId);
        else this.activeByTenant.set(task.tenantId, active);
        this.dispatch();
      });
    }
  }
}
