// Native adapter of cursor/plugins c742dd61 worker.ts; MIT (c) 2026 Lauren Tan.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { checkView } from "./frontends/view.ts";
import { compile } from "./pipeline.ts";
import { check, messageOf } from "./run.ts";
import { renderChart } from "./render.ts";
const [command, stage, spec, config, viewFile, edgeText] =
  process.argv.slice(2);
try {
  const draft = path.join(stage, "draft");
  fs.mkdirSync(draft);
  let exit = 0;
  if (command === "check") {
    const view = checkView(
      viewFile ? await import(pathToFileURL(viewFile).href) : {},
      inspect,
    );
    const result = compile(await check(spec, config), view, Number(edgeText));
    exit = result.exit;
    for (const [name, parts] of result.files) {
      const fd = fs.openSync(path.join(draft, name), "wx");
      try {
        for (const part of parts)
          fs.writeSync(fd, typeof part === "string" ? Buffer.from(part) : part);
        fs.writeSync(fd, "\n");
      } finally {
        fs.closeSync(fd);
      }
    }
    if (result.chart)
      fs.writeFileSync(
        path.join(draft, "chart.json"),
        JSON.stringify(result.chart),
        { flag: "wx" },
      );
  } else if (command === "render") {
    const chart = JSON.parse(
      fs.readFileSync(path.join(spec, "chart.json"), "utf8"),
    );
    fs.writeFileSync(
      path.join(draft, "chart.svg"),
      renderChart(chart, Number(edgeText)),
      { flag: "wx" },
    );
  } else throw new Error("Unknown internal operation");
  fs.renameSync(draft, path.join(stage, "done"));
  process.exit(exit);
} catch (e) {
  console.error(messageOf(e));
  process.exit(2);
}
