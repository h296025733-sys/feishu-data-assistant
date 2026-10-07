/**
 * Serializes state-changing work while coalescing identical in-flight requests.
 * Different keys keep their order instead of silently inheriting the first result.
 */
export class KeyedSerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  public run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const result = this.tail.catch(() => undefined).then(task);
    this.inFlight.set(key, result);
    this.tail = result.then(() => undefined, () => undefined);
    void result.finally(() => {
      if (this.inFlight.get(key) === result) this.inFlight.delete(key);
    }).catch(() => undefined);
    return result;
  }
}
