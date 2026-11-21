import { setFlagsFromString } from "node:v8";
setFlagsFromString("--no-incremental-marking");
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const { run } = await import("./solve.js");
const cases = JSON.parse(readFileSync("/input/cases.json", "utf8"));
const answers = cases.map((c) => run(c.input));
mkdirSync("/output", { recursive: true });
writeFileSync("/output/answers.json", JSON.stringify(answers));
