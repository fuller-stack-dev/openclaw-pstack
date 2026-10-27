#!/usr/bin/env node
// Native adaptation of the MIT-pinned plan checker. No upstream script is executed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const verificationRule = "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";
const blocks = ["Depends on.", "Files.", "Build.", "You see.", "Verify, unit.", "Verify, live.", "Verify, perf.", "Review gate.", "Merge."];
const programHeadings = ["Arm the program", "Spawn owners", "PR mechanics", "Verdict and merge", "Boot recipe"];
const appendices = ["Appendix A. Prototype evidence", "Appendix B. Alternatives rejected", "Appendix C. Risks", "Appendix D. Links and reading list"];
const boxPattern = /^\s*- \[[ xX]\] (.+)$/;

/**
 * Linear equivalents of /<[^>\n]+>/.test, and of removing /!\[[^\]]*\]\([^)]*\)/g then
 * replacing /\]\([^)]*\)/g with "]". The regexes rescan the rest of the line from
 * every unmatched start, which is quadratic on long lines of "<", "![" or "](".
 */
export function hasAngleTag(text) {
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") open = false;
    else if (c === ">" && open) return true;
    else if (c === "<" && i + 1 < text.length && text[i + 1] !== ">" && text[i + 1] !== "\n") open = true;
  }
  return false;
}
function nextIndexes(text, char) {
  const next = new Int32Array(text.length + 1).fill(-1);
  for (let i = text.length - 1; i >= 0; i--) next[i] = text[i] === char ? i : next[i + 1];
  return next;
}
export function stripLinkTargets(text) {
  const close = nextIndexes(text, ")"), bracket = nextIndexes(text, "]");
  let images = "";
  for (let i = 0; i < text.length;) {
    if (text[i] === "!" && text[i + 1] === "[") {
      const end = bracket[i + 2];
      if (end >= 0 && text[end + 1] === "(" && close[end + 2] >= 0) { i = close[end + 2] + 1; continue; }
    }
    images += text[i++];
  }
  const after = nextIndexes(images, ")");
  let out = "";
  for (let i = 0; i < images.length;) {
    if (images[i] === "]" && images[i + 1] === "(" && after[i + 2] >= 0) { out += "]"; i = after[i + 2] + 1; continue; }
    out += images[i++];
  }
  return out;
}

export function checkPlan(source, file = "plan.md") {
  const raw = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const problems = [];
  const fail = (line, message) => problems.push({ line, message });
  let start = 0;
  if (raw[0] === "---") {
    const end = raw.indexOf("---", 1);
    if (end === -1) fail(1, "unclosed frontmatter");
    else start = end + 1;
  }
  const lines = [];
  let fence;
  for (let i = start; i < raw.length; i++) {
    const text = raw[i];
    if (fence) {
      const closer = text.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (closer && closer[1][0] === fence.char && closer[1].length >= fence.length) fence = undefined;
      continue;
    }
    const opener = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opener && !(opener[1][0] === "`" && opener[2].includes("`"))) {
      fence = { char: opener[1][0], length: opener[1].length, line: i + 1 };
      continue;
    }
    const line = { n: i + 1, text };
    lines.push(line);
    if (hasAngleTag(text)) fail(line.n, "unfilled angle-bracket placeholder or HTML; use concrete Markdown evidence");
    const prose = stripLinkTargets(text.replace(/`[^`]*`/g, ""));
    if (/[\u2013\u2014]/.test(prose)) fail(line.n, "long dash");
    if (/[\u2018\u2019\u201c\u201d]/.test(prose)) fail(line.n, "curly quote");
    if (/: \S/.test(prose)) fail(line.n, "mid-sentence colon");
  }
  if (fence) fail(fence.line, "unclosed code fence");
  const textOf = (section) => section?.body.map((line) => line.text).join("\n") ?? "";
  const boxes = (body) => body.flatMap((line) => {
    const match = line.text.match(boxPattern);
    return match ? [{ n: line.n, text: match[1] }] : [];
  });
  const sections = [];
  for (const line of lines) {
    const heading = line.text.match(/^ {0,3}## (.+)$/);
    if (heading) sections.push({ title: heading[1].trim(), n: line.n, body: [] });
    else sections.at(-1)?.body.push(line);
  }
  for (const section of sections) {
    if (sections.some((other) => other !== section && other.title === section.title && other.n < section.n)) fail(section.n, `duplicate section "${section.title}"`);
  }
  const find = (title) => sections.find((section) => section.title === title);
  const h1s = lines.filter((line) => /^ {0,3}# /.test(line.text));
  if (h1s.length !== 1) fail(1, "exactly one H1 title required");
  const how = find("How to read this");
  const program = find("Program checklist");
  const close = find("Close the program");
  for (const title of ["How to read this", "Program checklist", "Close the program", ...appendices]) {
    if (!find(title)) fail(1, `missing "## ${title}"`);
  }
  if (how) {
    for (const marker of ["One box is one unit of work", "names the evidence", "Check a box only when its evidence exists", verificationRule]) {
      if (!textOf(how).includes(marker)) fail(how.n, `How to read this lacks "${marker}"`);
    }
    if (!/(?:playbooks\/|playbooks\.md#)(?:autopilot-full|autopilot-stack|orchestrate)(?:\.md|\b)/.test(textOf(how))) fail(how.n, "How to read this must name the execution playbook");
    if (h1s[0]) {
      const intro = lines.filter((line) => line.n > h1s[0].n && line.n < how.n && line.text.trim());
      if (intro.length >= 10) fail(h1s[0].n, "intro must have fewer than ten nonblank lines");
    }
  }
  if (how && program && how.n > program.n) fail(how.n, "How to read this must precede Program checklist");
  if (sections[0] !== how && how) fail(how.n, "How to read this must be the first H2");
  if (program && sections[1] !== program) fail(program.n, "Program checklist must be the second H2");
  if (program) {
    const headings = program.body.flatMap((line) => line.text.match(/^ {0,3}### (.+)$/)?.slice(1) ?? []);
    if (headings.length !== programHeadings.length || headings.some((heading, index) => !heading.startsWith(programHeadings[index]))) fail(program.n, "Program checklist headings must be Arm the program, Spawn owners, PR mechanics, Verdict and merge, Boot recipe in order");
    const text = textOf(program);
    for (const [pattern, message] of [
      [/explicit go/i, "operator explicit go"], [/trunk/i, "approved trunk reading"],
      [/native audit lifecycle/i, "native audit lifecycle"], [/status message/i, "status message policy"],
      [/zero-writes/i, "zero-writes stop propagation"], [/one owner per PR/i, "one owner per PR"],
      [/pstack_route/, "pstack_route planning"], [/sessions_spawn/, "native sessions_spawn"],
      [/patch-id/, "patch-id requalification"],
    ]) if (!pattern.test(text)) fail(program.n, `Program checklist lacks ${message}`);
  }
  const programIndex = sections.indexOf(program);
  const closeIndex = sections.indexOf(close);
  const prs = programIndex >= 0 && closeIndex > programIndex ? sections.slice(programIndex + 1, closeIndex) : [];
  if (!prs.length) fail(program?.n ?? 1, "no PR sections between Program checklist and Close the program");
  const reports = [];
  for (const pr of prs) {
    const heads = [];
    for (const line of pr.body) {
      const heading = line.text.match(/^\*\*([^*]+)\*\*(.*)$/);
      if (heading) heads.push({ name: heading[1], rest: heading[2].trim(), n: line.n, body: [] });
      else heads.at(-1)?.body.push(line);
    }
    if (heads.map((head) => head.name).join("|") !== blocks.join("|")) fail(pr.n, `${pr.title}: sub-blocks must be ${blocks.join(", ")} in order`);
    const block = (name) => heads.find((head) => head.name === name);
    if (block("Depends on.") && !block("Depends on.").rest) fail(block("Depends on.").n, `${pr.title}: Depends on names nothing`);
    for (const name of ["Files.", "Build.", "You see.", "Verify, unit.", "Merge."]) {
      const head = block(name);
      if (head && !boxes(head.body).length) fail(head.n, `${pr.title}: ${name} has no evidence box`);
    }
    for (const name of ["Verify, unit.", "Verify, live.", "Verify, perf."]) {
      const head = block(name);
      if (head && !head.rest.startsWith(verificationRule)) fail(head.n, `${pr.title}: ${name} must open with the verification rule`);
    }
    const live = block("Verify, live.");
    if (live) {
      if (!/Ten lanes on `[^`<>]+` at the PR head/.test(live.rest)) fail(live.n, `${pr.title}: live block needs ten lanes and the resolved native worker selection`);
      const lanes = boxes(live.body);
      const numbers = lanes.map((lane) => lane.text.match(/^Lane (\d+)\. /)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
      if (numbers.join(",") !== "1,2,3,4,5,6,7,8,9,10" || lanes.length !== 10) fail(live.n, `${pr.title}: live lanes must be exactly 1 through 10`);
      for (const lane of lanes) {
        if (!/Save `[^`<>]+`/.test(lane.text)) fail(lane.n, `${pr.title}: live lane needs a screenshot path`);
        if (!/Pass when .+/.test(lane.text)) fail(lane.n, `${pr.title}: live lane needs a pass predicate`);
      }
      if (!lanes.some((lane) => /Regression lane against trunk/.test(lane.text))) fail(live.n, `${pr.title}: missing Regression lane against trunk`);
    }
    const perf = block("Verify, perf.");
    if (perf) {
      const items = boxes(perf.body);
      if (items.map((item) => item.text.split(" ")[0]).join("|") !== "Metric.|Probe.|Baseline.|Rule.") fail(perf.n, `${pr.title}: perf boxes must be Metric, Probe, Baseline, Rule in order`);
      const rule = items.find((item) => item.text.startsWith("Rule."));
      if (rule && !/\d/.test(rule.text)) fail(rule.n, `${pr.title}: perf Rule needs a numeric failure threshold`);
    }
    const review = block("Review gate.");
    if (review) {
      const items = boxes(review.body);
      if (review.rest.startsWith("None.")) {
        if (!/is not review-gated\./.test(review.rest)) fail(review.n, `${pr.title}: None must name the PR as not review-gated`);
        if (items.length) fail(review.n, `${pr.title}: None review gate must have no boxes`);
      } else {
        if (!items.length) fail(review.n, `${pr.title}: review gate needs evidence boxes`);
        const text = textOf(review);
        for (const word of ["screenshot", "video", "operator"]) if (!text.includes(word)) fail(review.n, `${pr.title}: review gate lacks ${word}`);
      }
    }
    reports.push({ title: pr.title, boxes: boxes(pr.body).length, counts: Object.fromEntries(heads.map((head) => [head.name, boxes(head.body).length])) });
  }
  if (close) {
    if (!boxes(close.body).length) fail(close.n, "Close the program needs evidence boxes");
    const tail = sections.slice(closeIndex + 1);
    if (tail.map((section) => section.title).join("|") !== appendices.join("|")) fail(close.n, "Appendices A through D must follow Close the program in order");
    for (const appendix of tail) if (!textOf(appendix).trim()) fail(appendix.n, `${appendix.title} is empty`);
  }
  return { file, reports, problems };
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0].startsWith("-")) {
    console.error("Usage: node skills/pstack/scripts/plan-check.mjs <plan.md>");
    return 2;
  }
  let source;
  try { source = readFileSync(args[0], "utf8"); }
  catch (error) { console.error(`${args[0]}: cannot read plan (${error.code ?? "read error"})`); return 2; }
  const result = checkPlan(source, args[0]);
  for (const report of result.reports) console.log(`${report.title}  boxes=${report.boxes}`);
  console.log(`${result.reports.length} PR sections, ${result.problems.length} problems`);
  for (const problem of result.problems) console.error(`${result.file}:${problem.line}: ${problem.message}`);
  return result.problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
