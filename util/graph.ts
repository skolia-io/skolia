// A dependency graph: nodes, and edges from a node to the nodes that wait for it. runGraph
// runs its nodes, each once those it depends on are done, as many at once as the limit
// allows, so what doesn't depend on each other runs side by side.

declare const nodeBrand: unique symbol;
/** A node of one graph, as Graph.add gave it. */
export type NodeId = number & { readonly [nodeBrand]: true };

export class Graph<T> {
  readonly #values: T[] = [];
  /** By node, the nodes it depends on */
  readonly #before: NodeId[][] = [];
  /** By node, the nodes that depend on it */
  readonly #after: NodeId[][] = [];

  /** A new node, depending on nothing yet. */
  add(value: T): NodeId {
    const id = this.#values.length as NodeId;
    this.#values.push(value);
    this.#before.push([]);
    this.#after.push([]);
    return id;
  }

  /** after depends on before: it runs once before is done. */
  edge(before: NodeId, after: NodeId): void {
    if (!this.has(before) || !this.has(after)) throw new Error(`no node ${this.has(before) ? after : before}`);
    if (this.#before[after]?.includes(before)) return;
    this.#before[after]?.push(before);
    this.#after[before]?.push(after);
  }

  has(id: NodeId): boolean {
    return Number.isInteger(id) && id >= 0 && id < this.#values.length;
  }

  get size(): number {
    return this.#values.length;
  }

  /** Every node, in the order they were added. */
  ids(): NodeId[] {
    return this.#values.map((_, i) => i as NodeId);
  }

  value(id: NodeId): T {
    if (!this.has(id)) throw new Error(`no node ${id}`);
    return this.#values[id] as T;
  }

  /** The nodes it depends on. */
  before(id: NodeId): readonly NodeId[] {
    return this.#before[id] ?? [];
  }

  /** The nodes that depend on it. */
  after(id: NodeId): readonly NodeId[] {
    return this.#after[id] ?? [];
  }

  /** Every node, each after those it depends on. Throws if some depend on each other. */
  order(): NodeId[] {
    const waiting = this.ids().map((id) => this.before(id).length);
    const ready = this.ids().filter((id) => waiting[id] === 0);
    for (let i = 0; i < ready.length; i++) {
      for (const after of this.after(ready[i] as NodeId)) {
        waiting[after] = (waiting[after] ?? 0) - 1;
        if (waiting[after] === 0) ready.push(after);
      }
    }
    if (ready.length < this.size) throw new Error(`${this.size - ready.length} nodes depend on each other`);
    return ready;
  }
}

/** Runs each node's value once those it depends on are done, at most limit at once. Throws,
 * running none, if some depend on each other. After a failure no more start, and once
 * those running have ended it rejects with the first error. */
export async function runGraph<T>(graph: Graph<T>, limit: number, run: (value: T) => Promise<void>): Promise<void> {
  if (!(limit >= 1)) throw new Error(`the limit must be at least 1, not ${limit}`);
  graph.order();
  const waiting = graph.ids().map((id) => graph.before(id).length);
  const ready = graph.ids().filter((id) => waiting[id] === 0);

  await new Promise<void>((resolve, reject) => {
    let running = 0;
    let done = 0;
    let failure: { readonly error: unknown } | undefined;

    const next = (): void => {
      if (failure) {
        if (running === 0) reject(failure.error);
        return;
      }
      if (done === graph.size) return resolve();
      while (running < limit) {
        const id = ready.shift();
        if (id === undefined) return;
        start(id);
      }
    };

    const start = (id: NodeId): void => {
      running++;
      // A run that throws before it returns a promise fails like one that rejects
      Promise.resolve()
        .then(() => run(graph.value(id)))
        .then(
          () => {
            running--;
            done++;
            for (const after of graph.after(id)) {
              waiting[after] = (waiting[after] ?? 0) - 1;
              if (waiting[after] === 0) ready.push(after);
            }
            next();
          },
          (error: unknown) => {
            running--;
            failure ??= { error };
            next();
          },
        );
    };

    next();
  });
}
