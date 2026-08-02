#!/usr/bin/env node
// A terminal door to the same brain the console and the agents use — nothing
// more. Everything here is one POST to /api/mcp, so this file exists for the
// two things curl is genuinely bad at: escaping a markdown body into JSON, and
// unwrapping the MCP envelope (`result.content[0].text`) to get at the data.
//
// Zero dependencies on purpose. Node 20+ is already this repo's floor and has
// global fetch, so a checkout can run this without installing anything, and
// there is no second dependency tree to keep in step with the server's.
//
// It speaks the MODERN revision (2026-07-28): no initialize handshake, the
// protocol version declared per request. That is also the point — the server's
// own client should exercise the era the server claims to support.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROTOCOL_VERSION = "2026-07-28";
const META = "io.modelcontextprotocol/protocolVersion";

// A deliberately small .env reader: enough for tokens and a URL, and it strips
// the quotes dotenv uses. It does NOT expand \n — a value that needs escapes
// (EMBEDDINGS_QUERY_PREFIX) belongs to the server, never to this client.
function envFile(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  } catch {
    return {};
  }
}

const file = envFile(resolve(process.cwd(), ".env"));
const pick = (k) => process.env[k] ?? file[k];
const BASE = (pick("LORE_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
// Write first: a token that can only read turns every put into a confusing
// refusal, and a caller who wants read-only can say so with LORE_TOKEN.
const TOKEN = pick("LORE_TOKEN") ?? pick("BRAIN_WRITE_TOKEN") ?? pick("BRAIN_READ_TOKEN");

function die(msg, code = 1) {
  process.stderr.write(`lore: ${msg}\n`);
  process.exit(code);
}

// ONE door for every request this CLI makes, so the guards below cannot be
// skipped by a command that happens to POST somewhere else. They were: `sweep`
// used to call fetch directly, and therefore had no token check, no 401 check
// and no JSON check — it printed `{"detail":"write token required"}` and exited
// 0, which is exactly the failure the envelope comment below condemns.
async function post(path, body, headers = {}) {
  if (!TOKEN) die("no token — set LORE_TOKEN, or run from a checkout with .env");
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }).catch((e) => die(`cannot reach ${BASE} — is it running? (${e.message})`));
  if (res.status === 401) die("unauthorized — wrong or missing token");
  const parsed = await res.json().catch(() => die(`${BASE} did not answer JSON (${res.status})`));
  // A refusal arrives as an ordinary JSON body with an error status. Reporting
  // the body and exiting 0 would call it a success.
  if (!res.ok) die(`${path} → ${res.status} ${parsed?.detail ?? JSON.stringify(parsed)}`);
  return parsed;
}

async function rpc(method, params) {
  const body = await post(
    "/api/mcp",
    { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { [META]: PROTOCOL_VERSION } } },
    {
      // REQUIRED of a modern client on Streamable HTTP, and the server refuses a
      // header that disagrees with the body — so these are derived from the very
      // values sent below, never typed twice.
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": method,
      ...(typeof params?.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
  );
  if (body.error)
    die(`${body.error.message}${body.error.data ? ` ${JSON.stringify(body.error.data)}` : ""}`);
  return body.result;
}

// The envelope is the whole reason this file exists: a tool's payload arrives as
// a JSON string inside content[0].text, and isError is a FIELD rather than a
// transport failure — a caller that prints the envelope and exits 0 reports a
// refusal as a success.
async function tool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) die(text || "tool error");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const show = (v) =>
  process.stdout.write(`${typeof v === "string" ? v : JSON.stringify(v, null, 2)}\n`);
const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest.splice(i, 2)[1];
};
const has = (name) => {
  const i = rest.indexOf(name);
  if (i === -1) return false;
  rest.splice(i, 1);
  return true;
};

const HELP = `lore — terminal access to a Lore brain (${BASE})

  lore search <query> [-n 10]     hybrid search over pages
  lore recall <query> [-n 10]     durable agent memories only
  lore get <slug>                 one page
  lore put <slug> [--title T]     upsert a page, body from stdin
  lore rm <slug>                  soft-delete a page
  lore ls [-n 25]                 recently updated pages
  lore tools                      what this bearer may call
  lore call <tool> ['<json>']     any tool, raw
  lore sweep [--dry]              mention-linking pass (/api/maintenance)
  lore health                     graph health: orphans + broken links

Env: LORE_URL (default http://localhost:3000), LORE_TOKEN
     (falls back to BRAIN_WRITE_TOKEN / BRAIN_READ_TOKEN, incl. from ./.env)`;

switch (cmd) {
  case "search":
  case "recall": {
    const limit = Number(flag("-n") ?? 10);
    const query = rest.join(" ");
    if (!query) die(`usage: lore ${cmd} <query>`);
    show(await tool(cmd === "search" ? "search" : "recall", { query, limit }));
    break;
  }
  case "get":
    if (!rest[0]) die("usage: lore get <slug>");
    show(await tool("get_page", { slug: rest[0], fuzzy: true }));
    break;
  case "put": {
    const title = flag("--title");
    const slug = rest[0];
    if (!slug) die("usage: lore put <slug> [--title T] < body.md");
    if (process.stdin.isTTY) die("no body on stdin — pipe one: lore put note < file.md");
    const body = await readStdin();
    show(await tool("put_page", { slug, body, ...(title ? { title } : {}) }));
    break;
  }
  case "rm":
    if (!rest[0]) die("usage: lore rm <slug>");
    show(await tool("delete_page", { slug: rest[0] }));
    break;
  case "ls":
    show(await tool("list_pages", { limit: Number(flag("-n") ?? 25) }));
    break;
  case "tools": {
    const { tools } = await rpc("tools/list", {});
    show(tools.map((t) => `${t.name}\t${t.description.split(". ")[0]}`).join("\n"));
    break;
  }
  case "call": {
    if (!rest[0]) die("usage: lore call <tool> '<json args>'");
    let args = {};
    if (rest[1]) {
      try {
        args = JSON.parse(rest[1]);
      } catch (e) {
        die(`arguments must be JSON: ${e.message}`);
      }
    }
    show(await tool(rest[0], args));
    break;
  }
  case "sweep":
    // Not a tool — the one background job, and its own route. Same door.
    show(await post("/api/maintenance", has("--dry") ? { dryRun: true } : {}));
    break;
  case "health":
    show({
      orphans: await tool("find_orphans", { limit: 20 }),
      broken_links: await tool("list_broken_links", { limit: 20 }),
    });
    break;
  default:
    show(HELP);
    if (cmd) process.exit(cmd === "help" || cmd === "--help" ? 0 : 2);
}
