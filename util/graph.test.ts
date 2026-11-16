import assert from "node:assert/strict";
import { test } from "node:test";
import { GraphBuilder, runGraph, type Graph, type NodeId } from "./graph.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/** A graph of the nodes, in order, each depending on the earlier ones named. */
function graphOf(nodes: readonly (readonly [string, ...string[]])[]): Graph<string> {
  const builder = new GraphBuilder<string>();
  const ids = new Map<string, NodeId>();
  for (const [value, ...deps] of nodes) {
    ids.set(
      value,
      builder.add(
        value,
        deps.map((dep) => ids.get(dep) ?? (-1 as NodeId)),
      ),
    );
  }
  return builder.build();
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

test("a graph is built a node at a time, each depending on nodes already added", () => {
  const builder = new GraphBuilder<string>();
  const a = builder.add("a");
  const b = builder.add("b");
  const c = builder.add("c", [a, b, a]);
  assert.throws(() => builder.add("d", [7 as NodeId]), /node 3 depends on a node not added before it/);
  assert.throws(() => builder.add("d", [3 as NodeId]), /node 3 depends on a node not added before it/);
  const graph = builder.build();
  assert.deepEqual(graph, { nodes: ["a", "b", "c"], deps: [[], [], [a, b]] });
  builder.add("d", [c]);
  assert.equal(graph.nodes.length, 3, "a built graph doesn't change");
});

test("a node starts once all it depends on have ended", async () => {
  const graph = graphOf([["a"], ["b"], ["c", "a", "b"], ["d", "c", "a"]]);
  const { events } = await record(graph, 4);
  const at = (event: string) => events.indexOf(event);
  assert.ok(at("start c") > at("end a") && at("start c") > at("end b"));
  assert.ok(at("start d") > at("end c"));
  assert.equal(events.length, 8);
});

test("nodes that don't depend on each other run at once, up to the limit", async () => {
  const graph = graphOf([["a"], ["b"], ["c"], ["d"], ["e"]]);
  assert.equal((await record(graph, 2)).most, 2);
  assert.equal((await record(graph, 10)).most, 5);
  assert.equal((await record(graph, 1)).most, 1);
  await runGraph({ nodes: [], deps: [] }, 1, () => Promise.reject(new Error("nothing to run")));
});

test("the first failure aborts the rest, and it rejects with that failure once those running stop", async () => {
  const graph = graphOf([["a"], ["b"], ["c", "a"], ["d"]]);
  const events: string[] = [];
  await assert.rejects(
    runGraph(graph, 2, async (value, signal) => {
      events.push(`start ${value}`);
      if (value === "a") throw new Error("a failed");
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      events.push(`${value} saw the abort: ${(signal.reason as Error).message}`);
    }),
    /a failed/,
  );
  assert.deepEqual(events, ["start a", "start b", "b saw the abort: a failed"]);
  await assert.rejects(
    runGraph(graphOf([["a"]]), 1, () => {
      throw new Error("thrown at once");
    }),
    /thrown at once/,
  );
});

test("a graph whose node depends on one not before it, or no room to run, runs nothing", async () => {
  const ran: string[] = [];
  const run = async (value: string) => {
    ran.push(value);
  };
  const ahead = { nodes: ["a", "b"], deps: [[], [1 as NodeId]] };
  await assert.rejects(runGraph(ahead, 2, run), /node 1 depends on a node not before it/);
  await assert.rejects(runGraph(graphOf([["e"]]), 0, run), /at least 1 permit/);
  assert.deepEqual(ran, []);
});
