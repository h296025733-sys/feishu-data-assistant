export class SharedCardDeduper {
  private readonly recent = new Map<string, number>();

  public constructor(
    private readonly ttlMs = 10_000,
    private readonly maxEntries = 1_000,
  ) {}

  public accept(key: string, now = Date.now()): boolean {
    const lastAcceptedAt = this.recent.get(key) ?? 0;
    if (now - lastAcceptedAt < this.ttlMs) return false;
    this.recent.set(key, now);
    if (this.recent.size > this.maxEntries) {
      this.recent.delete(this.recent.keys().next().value as string);
    }
    return true;
  }
}
