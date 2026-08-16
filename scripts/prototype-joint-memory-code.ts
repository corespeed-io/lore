/** PROTOTYPE — interactive terminal shell; do not wire into production. */

import {
  createJointMemoryCodePrototypeSession,
  type JointPrototypeCaseResult,
} from "./lib/joint-memory-code-prototype-fixture";

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";
const session = await createJointMemoryCodePrototypeSession();
let caseIndex = 0;
let variantIndex = session.variants.length - 1;
let result: JointPrototypeCaseResult | null = null;
let busy = false;

async function evaluate(): Promise<void> {
  busy = true;
  result = await session.runCase(session.cases[caseIndex], session.variants[variantIndex]);
  busy = false;
}

function yesNo(value: boolean | null): string {
  if (value === null) return "n/a";
  return value ? "yes" : "NO";
}

function render(): void {
  console.clear();
  const evaluationCase = session.cases[caseIndex];
  const variant = session.variants[variantIndex];
  process.stdout.write(
    [
      `${bold}PROTOTYPE — joint Memory + Code evidence${reset}`,
      `${dim}Question: can selective orchestration preserve independent authority and beat always-on context?${reset}`,
      "",
      `${bold}case${reset}: ${evaluationCase.id} (${caseIndex + 1}/${session.cases.length})`,
      `${bold}query${reset}: ${evaluationCase.query}`,
      `${bold}variant${reset}: ${variant.id}`,
      `${bold}expected route${reset}: ${evaluationCase.expectedRoute}`,
      `${bold}state${reset}: ${busy ? "evaluating" : "ready"}`,
      "",
      `${bold}planned route${reset}: ${result?.packet.plan.route ?? "—"}`,
      `${bold}delivered route${reset}: ${result?.packet.deliveredRoute ?? "—"}`,
      `${bold}intent${reset}: ${result?.packet.plan.intent ?? "—"}`,
      `${bold}memory evidence${reset}: ${result?.packet.memories.length ?? 0}`,
      ...(result?.packet.memories.map(
        (memory) => `  ${dim}${memory.id}${reset} ${memory.content}`,
      ) ?? []),
      `${bold}code evidence${reset}: ${result?.packet.code.length ?? 0}`,
      ...(result?.packet.code.map(
        (artifact) =>
          `  ${artifact.path}:${artifact.symbol ?? "file"} @ ${artifact.commitOid.slice(0, 8)}`,
      ) ?? []),
      `${bold}anchors${reset}: ${result?.packet.anchors.length ?? 0}`,
      ...(result?.packet.anchors.map(
        (anchor) =>
          `  ${anchor.relationship}/${anchor.localState} ${anchor.citedPath} -> ${anchor.validatedPath ?? "—"}`,
      ) ?? []),
      `${bold}contextual impact${reset}: ${result?.packet.receipt.contextualImpact?.state ?? "n/a"}`,
      `${bold}conflicts${reset}: ${result?.packet.conflicts.join(", ") || "none"}`,
      "",
      `${bold}checks${reset}: route=${yesNo(result?.checks.route ?? null)} memory=${yesNo(result?.checks.memoryRecall ?? null)} memory@1=${yesNo(result?.checks.memoryTop1 ?? null)} code=${yesNo(result?.checks.codeRecall ?? null)} anchor=${yesNo(result?.checks.anchorState ?? null)} impact=${yesNo(result?.checks.contextualImpact ?? null)} conflict=${yesNo(result?.checks.conflict ?? null)} RLS=${yesNo(result?.checks.noLeakage ?? null)}`,
      "",
      `${bold}[n]${reset}${dim} next case  ${reset}${bold}[p]${reset}${dim} previous  ${reset}${bold}[v]${reset}${dim} next variant  ${reset}${bold}[b]${reset}${dim} previous variant  ${reset}${bold}[r]${reset}${dim} rerun  ${reset}${bold}[q]${reset}${dim} quit${reset}`,
      "",
    ].join("\n"),
  );
}

await evaluate();
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  const snapshot = result as JointPrototypeCaseResult | null;
  process.stdout.write(`${JSON.stringify(snapshot?.packet ?? null, null, 2)}\n`);
  await session.close();
} else {
  render();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (key: string) => {
    if (busy) return;
    if (key === "q" || key === "\u0003") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      await session.close();
      process.exit(0);
    }
    if (key === "n") caseIndex = (caseIndex + 1) % session.cases.length;
    if (key === "p") caseIndex = (caseIndex - 1 + session.cases.length) % session.cases.length;
    if (key === "v") variantIndex = (variantIndex + 1) % session.variants.length;
    if (key === "b") {
      variantIndex = (variantIndex - 1 + session.variants.length) % session.variants.length;
    }
    if (!["n", "p", "v", "b", "r"].includes(key)) return;
    await evaluate();
    render();
  });
}
