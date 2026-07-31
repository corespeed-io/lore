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
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${yamlValue(v)}`);
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
  return /^[A-Za-z0-9 _.\-/]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}
