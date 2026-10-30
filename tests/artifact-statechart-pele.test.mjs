import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const entry = require.resolve("pele");
const { render, PeleError } = await import(pathToFileURL(entry).href);
test("public Pele stateDiagram maxEdges is not a native safety boundary", () => {
  assert.match(
    render("stateDiagram-v2\n a --> b\n b --> c", { maxEdges: 1 }).svg,
    /<svg/,
  );
  assert.throws(
    () => render("flowchart TD\n a-->b\n b-->c", { maxEdges: 1 }),
    (e) => e.code === "limit",
  );
});
test("Pele errors and source/output limits are surfaced as text data", () => {
  assert.throws(
    () => render('stateDiagram-v2\n state "unclosed', { limit: 1000 }),
    (e) => e instanceof PeleError,
  );
  assert.throws(
    () => render("stateDiagram-v2\n a --> b", { limit: 5 }),
    (e) => e.code === "limit",
  );
  assert.throws(
    () => render("stateDiagram-v2\n a --> b", { outputLimit: 5 }),
    (e) => e.code === "limit",
  );
});
