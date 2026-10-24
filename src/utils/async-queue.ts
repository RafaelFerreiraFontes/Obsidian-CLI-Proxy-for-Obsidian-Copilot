export class AsyncQueue<T> {
  private values: T[] = [];
  private waiter: ((value: T) => void) | undefined;
  push(value: T): void {
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(value); }
    else this.values.push(value);
  }
  next(): Promise<T> {
    if (this.values.length) return Promise.resolve(this.values.shift()!);
    return new Promise(resolve => { this.waiter = resolve; });
  }
}
