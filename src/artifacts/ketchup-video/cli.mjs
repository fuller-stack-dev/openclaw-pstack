#!/usr/bin/env node
import { render, verify } from "./video.mjs";
import { doctor } from "./process.mjs";
const abort = new AbortController();
let caught;
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, () => {
    caught = sig;
    abort.abort();
  });
try {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === "doctor" && args.length === 0) result = await doctor(abort.signal);
  else if (command === "render" && args.length === 2)
    result = await render(args[0], args[1], abort.signal);
  else if (command === "verify" && args.length === 2)
    result = await verify(args[0], args[1], abort.signal);
  else
    throw Error(
      "Usage: ketchup-video doctor | render MANIFEST.json NEW_OR_EMPTY_DIR | verify MANIFEST.json OUTPUT_DIR",
    );
  console.log(JSON.stringify(result));
} catch (e) {
  console.error("Ketchup video failed: " + String(e.message).replace(/\s+/g, " ").slice(0, 1000));
  process.exitCode = caught === "SIGINT" ? 130 : caught ? 143 : 2;
}
