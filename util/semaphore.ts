/** At most limit permits out at once; the rest wait their turn. A permit is released when
 * it's disposed: `using permit = await semaphore.acquire()`. */
export class Semaphore {
  #free: number;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    if (!(limit >= 1)) throw new Error(`a semaphore needs at least 1 permit, not ${limit}`);
    this.#free = limit;
  }

  async acquire(): Promise<Disposable> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    let held = true;
    return {
      [Symbol.dispose]: () => {
        if (!held) return;
        held = false;
        // The permit passes to the next waiting, or is free again
        const next = this.#waiting.shift();
        if (next) next();
        else this.#free++;
      },
    };
  }
}
