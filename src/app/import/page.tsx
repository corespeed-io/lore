"use client";

// Vault import. The browser reads the folder with a plain directory input —
// no upload service, no server filesystem, so this page works the same on a
// Node host and on Workers. It posts small batches and reports what did not
// resolve, because an import that silently produces an edgeless graph is the
// signature failure of a tool like this.

import { useCallback, useRef, useState } from "react";

interface FileResult {
  path: string;
  slug?: string;
  status: "created" | "unchanged" | "skipped" | "failed";
  pending?: string[];
  detail?: string;
}

const BATCH = 25;

export default function ImportPage() {
  const [token, setToken] = useState("");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<FileResult[]>([]);
  const [error, setError] = useState("");
  const cancelled = useRef(false);

  const run = useCallback(
    async (picked: FileList) => {
      const files = [...picked].filter((f) => /\.(md|markdown)$/i.test(f.name));
      setError("");
      setResults([]);
      setDone(0);
      setTotal(files.length);
      if (files.length === 0) {
        setError("No .md files in that folder.");
        return;
      }
      setRunning(true);
      cancelled.current = false;
      const all: FileResult[] = [];
      try {
        for (let i = 0; i < files.length && !cancelled.current; i += BATCH) {
          const slice = files.slice(i, i + BATCH);
          const payload = await Promise.all(
            slice.map(async (f) => ({
              // webkitRelativePath keeps the folder structure the user picked,
              // which is what becomes the slug.
              path: f.webkitRelativePath || f.name,
              text: await f.text(),
            })),
          );
          const res = await fetch("/api/import", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ files: payload }),
          });
          if (!res.ok) {
            const detail = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
            throw new Error((detail as { detail?: string }).detail ?? `HTTP ${res.status}`);
          }
          const body = (await res.json()) as { results: FileResult[] };
          all.push(...body.results);
          setResults([...all]);
          setDone(Math.min(i + BATCH, files.length));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "import failed");
      } finally {
        setRunning(false);
      }
    },
    [token],
  );

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const broken = results.flatMap((r) => (r.pending ?? []).map((ref) => ({ path: r.path, ref })));
  const failures = results.filter((r) => r.status === "failed" || r.status === "skipped");

  return (
    <main className="import">
      <h1>Import a vault</h1>
      <p className="lede">
        Pick a folder of Markdown. Files become pages, folders become slug prefixes, and{" "}
        <code>[[wikilinks]]</code> become graph edges — including the ones in frontmatter.
        Re-importing the same folder is free: unchanged files are skipped.
      </p>

      <label className="field">
        <span>Write token</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="BRAIN_WRITE_TOKEN"
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span>Vault folder</span>
        <input
          type="file"
          // Reading a directory client-side; no server filesystem involved.
          // @ts-expect-error -- directory picking is not in React's typings
          webkitdirectory=""
          directory=""
          multiple
          disabled={!token || running}
          onChange={(e) => {
            if (e.target.files) void run(e.target.files);
          }}
        />
      </label>

      {running && (
        <p className="status">
          Importing {done} / {total}…{" "}
          <button
            type="button"
            onClick={() => {
              cancelled.current = true;
            }}
          >
            stop
          </button>
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {results.length > 0 && (
        <>
          <ul className="counts">
            {["created", "unchanged", "skipped", "failed"].map(
              (k) => counts[k] && <li key={k}>{`${counts[k]} ${k}`}</li>,
            )}
          </ul>

          {broken.length > 0 && (
            <section>
              <h2>{broken.length} links point at pages that do not exist</h2>
              <p className="lede">
                Usually a typo, or a note that was not part of this folder. Everything else imported
                fine.
              </p>
              <ul className="rows">
                {broken.slice(0, 100).map((b) => (
                  <li key={`${b.path}|${b.ref}`}>
                    <code>{b.ref}</code> <span className="dim">in {b.path}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {failures.length > 0 && (
            <section>
              <h2>{failures.length} files were not imported</h2>
              <ul className="rows">
                {failures.slice(0, 100).map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code> <span className="dim">{f.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
