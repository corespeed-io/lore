// A minimal USTAR writer, so "get my notes out" is one request and zero
// dependencies. tar (not zip) because a valid tar is 512-byte headers plus
// padded payloads and nothing else — no compression, no central directory.
// ponytail: `tar -xf` and every archive tool reads this; if browsers ever need
// a double-click format, pipe it through CompressionStream('gzip').

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

// USTAR splits a long name across prefix(155) + name(100). Anything longer than
// that combination cannot be represented, so the caller must not produce it.
export function splitPath(path: string): { name: string; prefix: string } | null {
  const bytes = new TextEncoder().encode(path).length;
  if (bytes !== path.length) {
    // Non-ASCII: the byte length is what the 100/155 fields count, and
    // splitting on a code point could land mid-sequence. Keep it simple and
    // only take what fits whole in `name`.
    return bytes <= 100 ? { name: path, prefix: "" } : null;
  }
  if (path.length <= 100) return { name: path, prefix: "" };
  const cut = path.lastIndexOf("/", path.length - 100);
  if (cut <= 0 || path.length - cut - 1 > 100 || cut > 155) return null;
  return { name: path.slice(cut + 1), prefix: path.slice(0, cut) };
}

function header(path: string, size: number, mtime: number): Uint8Array | null {
  const split = splitPath(path);
  if (!split) return null;
  const buf = new Uint8Array(BLOCK);
  const enc = new TextEncoder();
  const put = (offset: number, text: string, max: number) => {
    const bytes = enc.encode(text);
    if (bytes.length > max) return false;
    buf.set(bytes, offset);
    return true;
  };
  if (!put(0, split.name, 100)) return null;
  put(100, octal(0o644, 8), 8); // mode
  put(108, octal(0, 8), 8); // uid
  put(116, octal(0, 8), 8); // gid
  put(124, octal(size, 12), 12);
  put(136, octal(mtime, 12), 12);
  buf.fill(0x20, 148, 156); // checksum field is spaces while summing
  buf[156] = 0x30; // typeflag '0' = regular file
  put(257, "ustar", 6);
  buf[263] = 0x30;
  buf[264] = 0x30; // version "00"
  if (!put(345, split.prefix, 155)) return null;
  let sum = 0;
  for (const b of buf) sum += b;
  // POSIX writes the checksum as six octal digits, NUL, space — not the plain
  // octal() form the numeric fields use. tar validates this exactly.
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return buf;
}

export interface TarEntry {
  path: string;
  body: string;
}

// Streams the archive so a large brain never has to fit in memory at once.
// Entries whose path cannot be represented in USTAR are skipped and reported
// via onSkip, rather than silently corrupting the archive.
export function tarStream(
  entries: AsyncIterable<TarEntry>,
  mtime: number,
  onSkip?: (path: string) => void,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const iterator = entries[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          // Two zero blocks end the archive.
          controller.enqueue(new Uint8Array(BLOCK * 2));
          controller.close();
          return;
        }
        const body = enc.encode(next.value.body);
        const head = header(next.value.path, body.length, mtime);
        if (!head) {
          onSkip?.(next.value.path);
          continue;
        }
        controller.enqueue(head);
        controller.enqueue(body);
        const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
        if (pad) controller.enqueue(new Uint8Array(pad));
        return;
      }
    },
  });
}

export const SKIP_REPORT_PATH = "EXPORT-SKIPPED.txt";

// A skip is discovered mid-stream, when the response headers are long gone, so
// the report rides inside the archive as one last entry. It is yielded only
// after every page has been written, which is exactly when the skip list is
// complete: tarStream pulls the next entry only once the previous one is on the
// wire, so any skip has already been recorded by then.
export async function* withSkipReport(
  pages: AsyncIterable<TarEntry>,
  skipped: string[],
): AsyncGenerator<TarEntry> {
  yield* pages;
  if (skipped.length === 0) return;
  yield {
    path: SKIP_REPORT_PATH,
    body: `${skipped.length} page(s) were omitted: the path exceeds what the tar format can represent (USTAR allows 100 bytes of name plus a 155-byte directory prefix). Shorten these slugs and export again.\n\n${skipped.join("\n")}\n`,
  };
}

// Frontmatter + body, in the shape the importer reads back. Round-tripping
// matters more than matching any particular tool's style.
export function serializeNote(
  title: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const fm: Record<string, unknown> = { ...frontmatter };
  // The H1 already carries the title when it matches; keep it explicit anyway so
  // a re-import cannot lose a title that was only ever frontmatter.
  fm.title = title;
  const lines = Object.entries(fm)
    .filter(([k]) => SAFE_KEY.test(k))
    .map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function yamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => quote(String(x))).join(", ")}]`;
  if (v === null || v === undefined) return '""';
  if (typeof v === "object") return quote(JSON.stringify(v));
  return quote(String(v));
}

// Quote anything that would otherwise reparse as structure — a value like
// "[[MOC]]" must survive a round trip.
function quote(s: string): string {
  return /^[A-Za-z0-9 _.\-/]+$/.test(s) ? s : `"${oneLine(s.replace(/"/g, '\\"'))}"`;
}

// This frontmatter block is line-structured: exactly one `key: value` per entry,
// terminated by `---`. A newline inside a title or value would emit lines of its
// own, so a page titled "x\nrelated_ids: [victim]" injects real frontmatter —
// aliases, type, graph edges — on the next export→import round trip, and a
// `\n---` ends the block early. Escaped rather than stripped, so the character is
// still visible in the exported note instead of silently disappearing.
function oneLine(s: string): string {
  return (
    s
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      // U+2028/U+2029/U+0085 are line terminators to a JS regex but not to the
      // importer's line splitter, so a title carrying one made `(.*)$` fail to
      // span the value and the reader dropped the WHOLE entry — a silent loss of
      // frontmatter on round trip, not an injection but data loss all the same.
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029")
      .replace(/\u0085/g, "\\u0085")
  );
}

// A key is structure, not text: the importer reads `- x` as an element of the
// PREVIOUS key's block array and `a: b` as a new entry, so a key like "- pwned"
// or one containing a colon smuggles data into a neighbour. Keys the importer
// cannot mis-read are written as-is; anything else is dropped, because there is
// no escaping that makes an arbitrary key safe AND round-trippable, and silently
// writing a key that re-reads as something else is the bug.
const SAFE_KEY = /^[A-Za-z0-9_.][A-Za-z0-9_.\- ]*$/;
