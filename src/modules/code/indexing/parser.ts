import { extname } from "node:path";
import type { SgNode } from "@ast-grep/napi";
import { Lang, parseAsync } from "@ast-grep/napi";
import { CODE_INDEX_LIMITS } from "./limits";
import type {
  ArtifactSpan,
  CodeArtifactSymbol,
  CodeDependencyKind,
  CodeParseStatus,
  CodeSourceFile,
  LanguageSelection,
  PreparedArtifact,
  PreparedDependencyEdge,
  PreparedFileIndex,
  PreparedModuleBinding,
} from "./types";
import { hasControlCharacters, sha256 } from "./validation";

const SYMBOL_KINDS = new Set([
  "abstract_class_declaration",
  "abstract_method_signature",
  "ambient_declaration",
  "class_declaration",
  "enum_declaration",
  "function_declaration",
  "function_signature",
  "generator_function_declaration",
  "interface_declaration",
  "internal_module",
  "method_definition",
  "method_signature",
  "module",
  "type_alias_declaration",
  "variable_declarator",
]);

const FORCE_CHILDREN_KINDS = new Set([
  "abstract_class_declaration",
  "class_body",
  "class_declaration",
  "document",
  "export_statement",
  "interface_declaration",
  "internal_module",
  "lexical_declaration",
  "object_type",
  "program",
  "stylesheet",
  "variable_declaration",
]);

function nodeKind(node: SgNode): string {
  return String(node.kind());
}

function isSymbolNode(node: SgNode): boolean {
  const kind = nodeKind(node);
  if (!SYMBOL_KINDS.has(kind)) return false;
  if (kind !== "variable_declarator") return true;
  return !node
    .ancestors()
    .some((ancestor) =>
      [
        "arrow_function",
        "function_expression",
        "function_declaration",
        "generator_function",
        "generator_function_declaration",
        "method_definition",
      ].includes(nodeKind(ancestor)),
    );
}

function languageForPath(path: string): LanguageSelection | null {
  switch (extname(path).toLowerCase()) {
    case ".ts":
    case ".cts":
    case ".mts":
      return { language: "typescript", parserLanguage: Lang.TypeScript };
    case ".tsx":
      return { language: "tsx", parserLanguage: Lang.Tsx };
    case ".js":
    case ".cjs":
    case ".mjs":
      return { language: "javascript", parserLanguage: Lang.JavaScript };
    case ".jsx":
      return { language: "jsx", parserLanguage: Lang.JavaScript };
    case ".css":
      return { language: "css", parserLanguage: Lang.Css };
    case ".html":
    case ".htm":
    case ".xhtml":
      return { language: "html", parserLanguage: Lang.Html };
    default:
      return null;
  }
}

function fallbackLanguage(path: string): string {
  const extension = extname(path).toLowerCase().slice(1);
  return extension || "text";
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(starts: readonly number[], position: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= position) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function lineRange(
  starts: readonly number[],
  start: number,
  end: number,
): { startLine: number; endLine: number } {
  return {
    startLine: lineNumberAt(starts, start),
    endLine: lineNumberAt(starts, Math.max(start, end - 1)),
  };
}

function codePointBoundary(content: string, boundary: number, end: number): number {
  if (boundary >= end) return boundary;
  const previous = content.charCodeAt(boundary - 1);
  const next = content.charCodeAt(boundary);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? boundary - 1
    : boundary;
}

function hardSplitSpan(
  content: string,
  start: number,
  end: number,
  anchor: SgNode,
): ArtifactSpan[] {
  const spans: ArtifactSpan[] = [];
  let cursor = start;
  while (cursor < end) {
    let boundary = Math.min(end, cursor + CODE_INDEX_LIMITS.maximumArtifactCodeUnits);
    if (boundary < end) {
      const newline = content.lastIndexOf("\n", boundary - 1);
      if (newline > cursor) boundary = newline + 1;
    }
    if (boundary <= cursor) {
      boundary = Math.min(end, cursor + CODE_INDEX_LIMITS.maximumArtifactCodeUnits);
    }
    boundary = codePointBoundary(content, boundary, end);
    spans.push({ start: cursor, end: boundary, anchor });
    cursor = boundary;
  }
  return spans;
}

function mergeSpans(spans: readonly ArtifactSpan[], parent: SgNode): ArtifactSpan[] {
  const merged: ArtifactSpan[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (
      previous &&
      !firstNamedSymbol(previous.anchor) &&
      !firstNamedSymbol(span.anchor) &&
      span.end - previous.start <= CODE_INDEX_LIMITS.maximumArtifactCodeUnits
    ) {
      previous.end = span.end;
      previous.anchor = parent;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function attachLeadingComments(content: string, spans: readonly ArtifactSpan[]): ArtifactSpan[] {
  const attached: ArtifactSpan[] = [];
  for (const original of spans) {
    const span = { ...original };
    if (symbolForSpan(span.anchor)) {
      while (attached.length > 0) {
        const previous = attached.at(-1);
        if (!previous) break;
        if (
          nodeKind(previous.anchor) !== "comment" ||
          content.slice(previous.end, span.start).trim() ||
          span.end - previous.start > CODE_INDEX_LIMITS.maximumArtifactCodeUnits
        ) {
          break;
        }
        attached.pop();
        span.start = previous.start;
      }
    }
    attached.push(span);
  }
  return attached;
}

function partitionSpanRange(
  content: string,
  spans: readonly ArtifactSpan[],
  start: number,
  end: number,
): ArtifactSpan[] {
  const partitioned = spans.map((span) => ({ ...span }));
  const first = partitioned[0];
  const last = partitioned.at(-1);
  if (!first || !last) return partitioned;
  first.start = start;
  for (let index = 0; index < partitioned.length - 1; index += 1) {
    const current = partitioned[index];
    const next = partitioned[index + 1];
    if (current && next) {
      const gap = content.slice(current.end, next.start);
      const lastTokenOffset = gap.search(/\s*$/);
      const boundary = current.end + lastTokenOffset;
      current.end = boundary;
      next.start = boundary;
    }
  }
  last.end = end;
  return partitioned;
}

function structuralSpans(content: string, node: SgNode): ArtifactSpan[] {
  const range = node.range();
  const start = range.start.index;
  const end = range.end.index;
  const forceChildren = FORCE_CHILDREN_KINDS.has(nodeKind(node));
  if (end - start <= CODE_INDEX_LIMITS.maximumArtifactCodeUnits && !forceChildren) {
    return [{ start, end, anchor: node }];
  }

  const namedChildren = node
    .children()
    .filter((child) => child.isNamed() && child.range().end.index > child.range().start.index);
  if (namedChildren.length === 0) return hardSplitSpan(content, start, end, node);

  const childSpans = attachLeadingComments(
    content,
    namedChildren.flatMap((child) => structuralSpans(content, child)),
  );
  if (childSpans.length === 0) return hardSplitSpan(content, start, end, node);
  const partitioned = partitionSpanRange(content, childSpans, start, end);
  return mergeSpans(partitioned, node).flatMap((span) =>
    span.end - span.start > CODE_INDEX_LIMITS.maximumArtifactCodeUnits
      ? hardSplitSpan(content, span.start, span.end, span.anchor)
      : [span],
  );
}

function firstNamedSymbol(node: SgNode): SgNode | null {
  if (isSymbolNode(node)) return node;
  const found: SgNode[] = [];
  const visit = (candidate: SgNode) => {
    if (isSymbolNode(candidate)) {
      found.push(candidate);
      return;
    }
    for (const child of candidate.children()) {
      if (child.isNamed()) visit(child);
      if (found.length > 1) return;
    }
  };
  visit(node);
  return found.length === 1 ? (found[0] ?? null) : null;
}

function symbolName(node: SgNode): string | null {
  const fieldName = node.field("name");
  if (fieldName) return fieldName.text().trim() || null;
  for (const child of node.children()) {
    if (
      child.isNamed() &&
      ["identifier", "property_identifier", "type_identifier"].includes(nodeKind(child))
    ) {
      return child.text().trim() || null;
    }
  }
  return null;
}

function bindingNames(node: SgNode | null): string[] {
  if (!node) return [];
  const kind = nodeKind(node);
  if (
    kind === "identifier" ||
    kind === "shorthand_property_identifier_pattern" ||
    kind === "shorthand_property_identifier"
  ) {
    const name = node.text().trim();
    return name ? [name] : [];
  }
  const namedChildren = node.children().filter((child) => child.isNamed());
  if (kind === "pair_pattern") {
    return bindingNames(namedChildren.at(-1) ?? null);
  }
  if (kind === "assignment_pattern" || kind === "rest_pattern") {
    return bindingNames(namedChildren[0] ?? null);
  }
  if (kind === "property_identifier" || kind === "computed_property_name") return [];
  return [...new Set(namedChildren.flatMap(bindingNames))];
}

function symbolForSpan(anchor: SgNode): { node: SgNode; symbols: string[]; kind: string } | null {
  const lineage = [anchor, ...anchor.ancestors()];
  const nearestAncestor = lineage.find(isSymbolNode);
  const selected = nearestAncestor ?? firstNamedSymbol(anchor);
  if (!selected) return null;

  const ancestorNames = [...selected.ancestors()]
    .reverse()
    .filter(isSymbolNode)
    .map(symbolName)
    .filter((name): name is string => Boolean(name));
  const selectedNames =
    nodeKind(selected) === "variable_declarator"
      ? bindingNames(selected.field("name"))
      : [symbolName(selected)].filter((name): name is string => Boolean(name));
  const symbols = selectedNames.map((name) => [...ancestorNames, name].join("."));
  if (symbols.length === 0) return null;
  return { node: selected, symbols, kind: nodeKind(selected) };
}

function parserErrorCoverage(root: SgNode): number {
  const rootRange = root.range();
  const rootLength = Math.max(1, rootRange.end.index - rootRange.start.index);
  const errors = root.findAll({ rule: { kind: "ERROR" } });
  if (errors.length === 0) return 0;
  const ranges = errors
    .map((error) => [error.range().start.index, error.range().end.index] as const)
    .sort((left, right) => left[0] - right[0]);
  let covered = 0;
  const firstRange = ranges[0];
  if (!firstRange) return 0;
  let [start, end] = firstRange;
  for (const [nextStart, nextEnd] of ranges.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      covered += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  covered += end - start;
  return covered / rootLength;
}

function fallbackSpans(content: string): Array<{ start: number; end: number }> {
  if (!content) return [];
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < content.length) {
    let boundary = Math.min(content.length, cursor + CODE_INDEX_LIMITS.maximumArtifactCodeUnits);
    if (boundary < content.length) {
      const newline = content.lastIndexOf("\n", boundary - 1);
      if (newline > cursor) boundary = newline + 1;
    }
    if (boundary <= cursor) {
      boundary = Math.min(content.length, cursor + CODE_INDEX_LIMITS.maximumArtifactCodeUnits);
    }
    boundary = codePointBoundary(content, boundary, content.length);
    spans.push({ start: cursor, end: boundary });
    cursor = boundary;
  }
  return spans;
}

function artifactsFromSpans(
  path: string,
  content: string,
  language: string,
  spans: readonly ArtifactSpan[],
  parseStatus: CodeParseStatus,
): PreparedArtifact[] {
  const declarationKeys = new Map<string, string>();
  const declarationOccurrences = new Map<string, number>();
  const declarationChunkOrdinals = new Map<number, number>();
  const starts = lineStarts(content);
  return spans.flatMap((span, ordinal) => {
    const selectedContent = content.slice(span.start, span.end);
    if (!selectedContent) return [];
    const identified = symbolForSpan(span.anchor);
    const symbols: CodeArtifactSymbol[] = [];
    const declarationChunkOrdinal = identified
      ? (declarationChunkOrdinals.get(identified.node.id()) ?? 0)
      : null;
    if (identified) {
      declarationChunkOrdinals.set(identified.node.id(), (declarationChunkOrdinal ?? 0) + 1);
      for (const symbol of identified.symbols) {
        const symbolKey = `${path}#${identified.kind}:${symbol}`;
        const nodeSymbolKey = `${identified.node.id()}:${symbolKey}`;
        let declarationKey = declarationKeys.get(nodeSymbolKey);
        if (!declarationKey) {
          const occurrence = declarationOccurrences.get(symbolKey) ?? 0;
          declarationOccurrences.set(symbolKey, occurrence + 1);
          declarationKey = occurrence === 0 ? symbolKey : `${symbolKey}~${occurrence + 1}`;
          declarationKeys.set(nodeSymbolKey, declarationKey);
        }
        symbols.push({ declarationKey, symbol, symbolKey });
      }
    }
    const primarySymbol = symbols[0] ?? null;
    const lines = lineRange(starts, span.start, span.end);
    return [
      {
        path,
        language,
        parser: "tree_sitter" as const,
        parseStatus,
        kind: identified?.kind ?? nodeKind(span.anchor),
        symbol: primarySymbol?.symbol ?? null,
        symbolKey: primarySymbol?.symbolKey ?? null,
        declarationKey: primarySymbol?.declarationKey ?? null,
        declarationChunkOrdinal,
        symbols,
        ordinal,
        startIndex: span.start,
        endIndex: span.end,
        ...lines,
        content: selectedContent,
        contentSha256: sha256(selectedContent),
      },
    ];
  });
}

function fallbackArtifacts(path: string, content: string, language: string): PreparedArtifact[] {
  const starts = lineStarts(content);
  return fallbackSpans(content).map((span, ordinal) => {
    const selectedContent = content.slice(span.start, span.end);
    return {
      path,
      language,
      parser: "text",
      parseStatus: "fallback",
      kind: "text_chunk",
      symbol: null,
      symbolKey: null,
      declarationKey: null,
      declarationChunkOrdinal: null,
      symbols: [],
      ordinal,
      startIndex: span.start,
      endIndex: span.end,
      ...lineRange(starts, span.start, span.end),
      content: selectedContent,
      contentSha256: sha256(selectedContent),
    };
  });
}

function descendantsOfKind(node: SgNode, kind: string): SgNode[] {
  const matches: SgNode[] = [];
  const stack = [...node.children().reverse()];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate) continue;
    if (nodeKind(candidate) === kind) matches.push(candidate);
    stack.push(...candidate.children().reverse());
  }
  return matches;
}

function moduleSpecifier(node: SgNode): string | null {
  const source = node.field("source")?.text().trim() ?? "";
  const unquoted =
    source.length >= 2 &&
    ((source.startsWith('"') && source.endsWith('"')) ||
      (source.startsWith("'") && source.endsWith("'")) ||
      (source.startsWith("`") && source.endsWith("`")))
      ? source.slice(1, -1)
      : source;
  return unquoted || null;
}

function importBindings(node: SgNode): PreparedModuleBinding[] {
  const clause = descendantsOfKind(node, "import_clause")[0];
  if (!clause) return [];
  const bindings: PreparedModuleBinding[] = [];
  for (const child of clause.children().filter((candidate) => candidate.isNamed())) {
    const kind = nodeKind(child);
    if (kind === "identifier") {
      const localName = child.text().trim();
      if (localName) bindings.push({ kind: "default", localName, importedName: "default" });
    } else if (kind === "named_imports") {
      for (const specifier of descendantsOfKind(child, "import_specifier")) {
        const identifiers = descendantsOfKind(specifier, "identifier")
          .map((identifier) => identifier.text().trim())
          .filter(Boolean);
        const importedName = identifiers[0];
        const localName = identifiers.at(-1);
        if (importedName && localName) bindings.push({ kind: "named", importedName, localName });
      }
    } else if (kind === "namespace_import") {
      const localName = descendantsOfKind(child, "identifier")[0]?.text().trim();
      if (localName) bindings.push({ kind: "namespace", localName });
    }
  }
  return bindings;
}

function reexportBindings(node: SgNode): PreparedModuleBinding[] {
  const clause = descendantsOfKind(node, "export_clause")[0];
  if (!clause) return [{ kind: "reexport_all" }];
  return descendantsOfKind(clause, "export_specifier").flatMap((specifier) => {
    const identifiers = descendantsOfKind(specifier, "identifier")
      .map((identifier) => identifier.text().trim())
      .filter(Boolean);
    const importedName = identifiers[0];
    const exportedName = identifiers.at(-1);
    return importedName && exportedName
      ? [{ kind: "reexport_named" as const, importedName, exportedName }]
      : [];
  });
}

function dependencyEdgesFromTree(
  path: string,
  root: SgNode,
  artifacts: readonly PreparedArtifact[],
): PreparedDependencyEdge[] {
  const dependencies: PreparedDependencyEdge[] = [];
  const appendDependency = (
    node: SgNode,
    kind: CodeDependencyKind,
    targetText: string,
    moduleBindings: readonly PreparedModuleBinding[] = [],
  ): void => {
    const normalizedTarget = targetText.trim();
    const range = node.range();
    const fromArtifact = artifacts.find(
      (artifact) =>
        artifact.startIndex <= range.start.index && range.start.index < artifact.endIndex,
    );
    if (
      !fromArtifact ||
      !normalizedTarget ||
      normalizedTarget.length > 1_600 ||
      hasControlCharacters(normalizedTarget)
    ) {
      return;
    }
    dependencies.push({
      path,
      fromArtifactOrdinal: fromArtifact.ordinal,
      fromSymbolKey: (() => {
        const identified = symbolForSpan(node);
        const symbol = identified?.symbols[0];
        if (!identified || !symbol) return null;
        const symbolKey = `${path}#${identified.kind}:${symbol}`;
        return fromArtifact.symbols.some((artifactSymbol) => artifactSymbol.symbolKey === symbolKey)
          ? symbolKey
          : null;
      })(),
      kind,
      targetText: normalizedTarget,
      moduleBindings,
      siteStartLine: range.start.line + 1,
      siteStartColumn: range.start.column,
      siteEndLine: range.end.line + 1,
      siteEndColumn: range.end.column,
    });
  };
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    const kind = nodeKind(node);
    if (kind === "call_expression") {
      const target = node.field("function");
      if (target) appendDependency(node, "calls", target.text());
    } else if (kind === "import_statement") {
      const source = moduleSpecifier(node);
      if (source) appendDependency(node, "imports", source, importBindings(node));
    } else if (kind === "export_statement") {
      const source = moduleSpecifier(node);
      if (source) appendDependency(node, "imports", source, reexportBindings(node));
    } else if (kind === "type_identifier") {
      const isDefinitionName = node.ancestors().some((ancestor) => {
        if (!isSymbolNode(ancestor)) return false;
        return ancestor.field("name")?.id() === node.id();
      });
      if (!isDefinitionName) appendDependency(node, "references", node.text());
    } else if (kind === "jsx_opening_element" || kind === "jsx_self_closing_element") {
      const target =
        node
          .children()
          .find((child) => child.isNamed())
          ?.text()
          .trim() ?? "";
      if (/^[A-Z]/.test(target)) appendDependency(node, "references", target);
    }
    stack.push(...node.children().reverse());
  }
  return dependencies;
}

export async function prepareFile(file: CodeSourceFile): Promise<PreparedFileIndex> {
  const selection = languageForPath(file.path);
  if (!selection) {
    return {
      artifacts: fallbackArtifacts(file.path, file.content, fallbackLanguage(file.path)),
      dependencies: [],
    };
  }
  if (!file.content) return { artifacts: [], dependencies: [] };
  try {
    const root = (await parseAsync(selection.parserLanguage, file.content)).root();
    const errorCoverage = parserErrorCoverage(root);
    if (errorCoverage > 0.25) {
      return {
        artifacts: fallbackArtifacts(file.path, file.content, selection.language),
        dependencies: [],
      };
    }
    const artifacts = artifactsFromSpans(
      file.path,
      file.content,
      selection.language,
      structuralSpans(file.content, root),
      errorCoverage > 0 ? "recovered" : "parsed",
    );
    return {
      artifacts,
      dependencies: dependencyEdgesFromTree(file.path, root, artifacts),
    };
  } catch {
    return {
      artifacts: fallbackArtifacts(file.path, file.content, selection.language),
      dependencies: [],
    };
  }
}
