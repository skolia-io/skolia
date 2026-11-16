// A dependency graph, and running it: each node once those it depends on are done, as many
// at once as the limit allows, so what doesn't depend on each other runs side by side.
import { Semaphore } from "./semaphore.ts";

declare const nodeBrand: unique symbol;
/** A node of a graph: its index in nodes. */
export type NodeId = number & { readonly [nodeBrand]: true };

/** Nodes, and by node, the nodes it depends on, which come before it: so it has no cycles. */
export type Graph<T> = { readonly nodes: readonly T[]; readonly deps: readonly (readonly NodeId[])[] };

/** Builds a graph a node at a time, each depending on nodes already added. */
export class GraphBuilder<T> {
  readonly #nodes: T[] = [];
  readonly #deps: (readonly NodeId[])[] = [];

  add(value: T, deps: readonly NodeId[] = []): NodeId {
    const id = this.#nodes.length as NodeId;
    if (deps.some((dep) => !(dep >= 0 && dep < id))) throw new Error(`node ${id} depends on a node not added before it`);
    this.#nodes.push(value);
    this.#deps.push([...new Set(deps)]);
    return id;
  }

  build(): Graph<T> {
    return { nodes: [...this.#nodes], deps: [...this.#deps] };
  }
}

/** Runs each node once those it depends on are done, at most limit at once. The first
 * failure aborts the signal run is given, so no more start and those running can stop;
 * once they have, it rejects with that failure. */
export async function runGraph<T>(graph: Graph<T>, limit: number, run: (value: T, signal: AbortSignal) => Promise<void>): Promise<void> {
  for (const [id, deps] of graph.deps.entries()) {
    if (deps.some((dep) => !(dep >= 0 && dep < id))) throw new Error(`node ${id} depends on a node not before it`);
  }
  const semaphore = new Semaphore(limit);
  const abort = new AbortController();
  /** By node, when it's done. A node's deps come before it, so theirs are here already. */
  const done: Promise<void>[] = [];
  const runNode = async (id: number, value: T): Promise<void> => {
    await Promise.all((graph.deps[id] ?? []).map((dep) => done[dep]));
    using _permit = await semaphore.acquire();
    abort.signal.throwIfAborted();
    try {
      await run(value, abort.signal);
    } catch (error) {
      // Before the permit passes on, so the next to hold it sees the abort
      if (!abort.signal.aborted) abort.abort(error);
      throw error;
    }
  };
  for (const [id, value] of graph.nodes.entries()) done[id] = runNode(id, value);
  await Promise.allSettled(done);
  if (abort.signal.aborted) throw abort.signal.reason;
}
