// Native reviewed port of cursor/plugins c742dd61706fbacc1b95f1a20b7b988cf096ce6c; MIT (c) 2026 Lauren Tan. See PORT.md.
import { mermaidLines } from "./backends/mermaid.ts";
import { plainText } from "./backends/plain-text.ts";
import { report } from "./backends/report.ts";
import {
  type Answers,
  type Bug,
  type Chart,
  type CheckedView,
  type CheckResult,
  type Graph,
  PART,
  ruleKey,
  type Story,
  type View,
  type Walk,
} from "./ir.ts";
import { asParents, ask, labelGraph, storiesOf } from "./passes/label.ts";
import { lift } from "./passes/lift.ts";
import { loopCheck } from "./passes/loop-check.ts";
import { bugs, drawOrder, walk } from "./passes/reach.ts";
import { regionsLie } from "./passes/region-check.ts";
import { drawRegions } from "./passes/regions.ts";

function* inParts(lines: string[]) {
  let start = 0;
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i].length + 1;
    if (size > PART || i === lines.length - 1) {
      yield (start ? "\n" : "") + lines.slice(start, i + 1).join("\n");
      start = i + 1;
      size = 0;
    }
  }
}

const shortestFirst = (a: { path: unknown[] }, b: { path: unknown[] }) =>
  a.path.length - b.path.length;

export function project(graph: Graph, walked: Walk, view: View, found: Bug[]) {
  const { order, rank } = drawOrder(walked);
  const draw = (answers: Answers) => {
    const labels = labelGraph(graph, walked, answers, rank, found);
    return { labels, chart: drawRegions(walked, labels, order, found, view) };
  };
  const answers = ask(graph, walked, view);
  const first = draw(answers);
  const lie = regionsLie(first.chart.regions, first.labels, walked, order);
  const { labels, chart } = lie ? draw(asParents(walked, answers)) : first;
  loopCheck(chart, labels, walked, found);
  return {
    chart: lift(lie ? { ...chart, lie } : chart),
    stories: storiesOf(graph, found, walked, first.labels),
  };
}

export function compile(
  result: CheckResult,
  view: CheckedView,
  maxEdges = 10000,
) {
  const walked = walk(result.graph);
  const found = [...(result.paths ?? bugs(result.graph, walked))].sort(
    shortestFirst,
  );
  for (const p of result.properties)
    if (p.bug) found.push({ rule: p.rule, ...p.bug });
  const { chart, stories } =
    found.length || !result.paths
      ? project(result.graph, walked, view, found)
      : { chart: undefined, stories: new Map<Bug, Story>() };
  const edges =
    chart?.regions.reduce(
      (n, r) => n + r.steps.length + r.states.filter((s) => s.start).length,
      0,
    ) ?? 0;
  let omitted = edges > maxEdges;
  let omitReason = omitted
    ? `projected edge limit ${maxEdges} exceeded (${edges})`
    : "";
  const lines = chart && !omitted ? mermaidLines(chart) : undefined;
  if (
    lines &&
    (lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0) >
      1_000_000 ||
      Buffer.byteLength(JSON.stringify(chart)) > 8_000_000)
  ) {
    omitted = true;
    omitReason = "chart source/output size limit exceeded";
  }
  const text =
    report(result, found, chart, stories) +
    (omitted
      ? `

Chart omitted: ${omitReason}; TLC verification is unchanged.`
      : "");
  const files = new Map<string, Iterable<string | Uint8Array>>();
  if (chart && !omitted) files.set("chart.mmd", inParts(lines!));
  files.set("report.md", [text]);
  files.set("tlc.out", plainText(result.messages));
  const drawn = new Set<string>();
  for (const b of found)
    if (b.rule.kind !== "property") drawn.add(ruleKey(b.rule));
  for (const { rule, outcome, messages } of [
    ...result.rules,
    ...result.properties,
  ])
    if (outcome === "broken" && messages && !drawn.has(ruleKey(rule)))
      files.set(`tlc-${rule.name}.out`, plainText(messages));
  return {
    report: text,
    files,
    exit: result.exit,
    chart: omitted ? undefined : chart,
    edges,
  };
}
