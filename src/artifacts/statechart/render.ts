import { render } from "pele";
import { mermaid } from "./backends/mermaid.ts";
import type { Chart } from "./ir.ts";
export const SOURCE_LIMIT = 1_000_000;
export const OUTPUT_LIMIT = 8_000_000;
export const EDGE_LIMIT = 10_000;
function assertChart(value: unknown): asserts value is Chart {
  const c = value as Chart;
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  const fail = () => {
    throw new Error("Invalid compiled chart");
  };
  if (
    !c ||
    typeof c !== "object" ||
    !Array.isArray(c.regions) ||
    !c.regions.length ||
    c.regions.length > 500 ||
    !strings(c.notes) ||
    !strings(c.paths) ||
    !strings(c.loops) ||
    !c.colors ||
    typeof c.colors !== "object" ||
    (c.title !== undefined && typeof c.title !== "string")
  )
    fail();
  for (const color of Object.values(c.colors))
    if (
      !["blue", "orange", "purple", "yellow", "teal", "tan", "pink"].includes(
        color,
      )
    )
      fail();
  let states = 0;
  for (const r of c.regions) {
    if (
      !r ||
      typeof r.name !== "string" ||
      !Array.isArray(r.states) ||
      !Array.isArray(r.steps)
    )
      fail();
    states += r.states.length;
    if (states > 10000) fail();
    for (const s of r.states) {
      if (
        !s ||
        !strings(s.path) ||
        !s.path.length ||
        s.path.length > 64 ||
        !Array.isArray(s.breaks)
      )
        fail();
      for (const k of ["start", "works", "lead", "repeats"] as const)
        if (typeof s[k] !== "boolean") fail();
      if (
        s.group !== undefined &&
        typeof s.group !== "string" &&
        typeof s.group !== "number" &&
        typeof s.group !== "boolean" &&
        s.group !== null
      )
        fail();
      for (const b of s.breaks)
        if (
          !b ||
          typeof b.always !== "boolean" ||
          !b.rule ||
          typeof b.rule.name !== "string" ||
          !["invariant", "property", "deadlock"].includes(b.rule.kind)
        )
          fail();
    }
    for (const s of r.steps)
      if (
        !s ||
        !strings(s.from) ||
        !s.from.length ||
        !strings(s.to) ||
        !s.to.length ||
        typeof s.label !== "string" ||
        (s.when !== undefined && typeof s.when !== "string")
      )
        fail();
  }
}
export function chartEdges(chart: Chart) {
  return chart.regions.reduce(
    (n, r) => n + r.steps.length + r.states.filter((s) => s.start).length,
    0,
  );
}
export function renderChart(chart: Chart, maxEdges = EDGE_LIMIT) {
  // Count typed projected edges, including start arrows, BEFORE constructing Mermaid.
  assertChart(chart);
  const edges = chartEdges(chart);
  if (edges > maxEdges)
    throw new Error("Chart edge limit exceeded: " + edges + " > " + maxEdges);
  const source = mermaid(chart);
  if (Buffer.byteLength(source) > SOURCE_LIMIT)
    throw new Error("Chart source limit exceeded");
  const result = render(source, {
    limit: SOURCE_LIMIT,
    outputLimit: OUTPUT_LIMIT,
  });
  if (Buffer.byteLength(result.svg) > OUTPUT_LIMIT)
    throw new Error("SVG output limit exceeded");
  return result.svg;
}
