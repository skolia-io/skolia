import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph, runGraph, type NodeId } from "./graph.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/** A graph of the nodes, and edges [before, after] by their values. */
function graphOf(values: readonly string[], edges: readonly (readonly [string, string])[] = []): Graph<string> {
  const graph = new Graph<string>();
  const ids = new Map(values.map((v) => [v, graph.add(v)]));
  const id = (v: string): NodeId => {
    const found = ids.get(v);
    if (found === undefined) throw new Error(`no ${v}`);
    return found;
  };
  for (const [before, after] of edges) graph.edge(id(before), id(after));
  return graph;
}

/** Runs the graph, recording when each node starts and ends, and the most that ran at once. */
async function record(graph: Graph<string>, limit: number) {
  const events: string[] = [];
  let running = 0;
  let most = 0;
  await runGraph(graph, limit, async (value) => {
    events.push(`start ${value}`);
    most = Math.max(most, ++running);
    await tick();
    running--;
    events.push(`end ${value}`);
  });
  return { events, most };
}

test("a graph knows each node's value, what it depends on and what depends on it", () => {
  const graph = graphOf(
    ["a", "b", "c"],
    [
      ["a", "c"],
      ["b", "c"],
      ["a", "c"],
    ],
  );
  const [a, b, c] = graph.ids();
  assert.ok(a !== undefined && b !== undefined && c !== undefined);
  assert.equal(graph.size, 3);
  assert.equal(graph.value(c), "c");
  assert.deepEqual(graph.before(c), [a, b]);
  assert.deepEqual(graph.after(a), [c]);
  assert.deepEqual(graph.before(a), []);
  assert.throws(() => graph.edge(a, 7 as NodeId), /no node 7/);
  assert.throws(() => graph.value(-1 as NodeId), /no node -1/);
});

test("order puts each node after those it depends on, and refuses a cycle", () => {
  const graph = graphOf(
    ["d", "c", "b", "a"],
    [
      ["a", "c"],
      ["b", "c"],
      ["c", "d"],
    ],
  );
  assert.deepEqual(
    graph.order().map((id) => graph.value(id)),
    ["b", "a", "c", "d"],
  );
  const cycle = graphOf(
    ["a", "b", "c"],
    [
      ["a", "b"],
      ["b", "a"],
    ],
  );
  assert.throws(() => cycle.order(), /2 nodes depend on each other/);
});

test("a node starts once all it depends on have ended", async () => {
  const graph = graphOf(
    ["d", "c", "b", "a"],
    [
      ["a", "c"],
      ["b", "c"],
      ["c", "d"],
      ["a", "d"],
    ],
  );
  const { events } = await record(graph, 4);
  const at = (event: string) => events.indexOf(event);
  assert.ok(at("start c") > at("end a") && at("start c") > at("end b"));
  assert.ok(at("start d") > at("end c"));
  assert.equal(events.length, 8);
});

test("nodes that don't depend on each other run at once, up to the limit", async () => {
  const graph = graphOf(["a", "b", "c", "d", "e"]);
  assert.equal((await record(graph, 2)).most, 2);
  assert.equal((await record(graph, 10)).most, 5);
  assert.equal((await record(graph, 1)).most, 1);
  await runGraph(new Graph(), 1, () => Promise.reject(new Error("nothing to run")));
});

test("after a failure no more start, those running end, and it rejects with the first error", async () => {
  const graph = graphOf(["a", "b", "c"], [["a", "c"]]);
  const events: string[] = [];
  await assert.rejects(
    runGraph(graph, 2, async (value) => {
      events.push(`start ${value}`);
      await tick();
      events.push(`end ${value}`);
      if (value === "a") throw new Error("a failed");
    }),
    /a failed/,
  );
  assert.deepEqual(events.toSorted(), ["end a", "end b", "start a", "start b"]);
  await assert.rejects(
    runGraph(graphOf(["a"]), 1, () => {
      throw new Error("thrown at once");
    }),
    /thrown at once/,
  );
});

test("a graph with a cycle, or no room to run, runs nothing", async () => {
  const ran: string[] = [];
  const run = async (value: string) => {
    ran.push(value);
  };
  const cycle = graphOf(
    ["a", "b", "c"],
    [
      ["a", "b"],
      ["b", "a"],
    ],
  );
  await assert.rejects(runGraph(cycle, 2, run), /2 nodes depend on each other/);
  await assert.rejects(runGraph(graphOf(["e"]), 0, run), /at least 1/);
  assert.deepEqual(ran, []);
});
