/** Spread startup/full-scan bursts across stores without delaying IM timers. */
export class GuardStartupQueue {
  private tail: Promise<void> = Promise.resolve();
  public constructor(private readonly spacingMs = 3_000) {}
  public run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.then(() => undefined, () => undefined).then(() => new Promise<void>((resolve) => {
      if (this.spacingMs <= 0) resolve();
      else setTimeout(resolve, this.spacingMs);
    }));
    return result;
  }
}
