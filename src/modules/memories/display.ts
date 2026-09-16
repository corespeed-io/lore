import type { Memory } from "./types";

function compact(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

export function memoryTitle(memory: Memory): string {
  const configured = memory.metadata.title;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const firstLine = memory.content.split(/\r?\n/, 1)[0] ?? memory.content;
  return compact(firstLine.replace(/^#+\s*/, ""), 96) || "Untitled memory";
}

export function memoryType(memory: Memory): string {
  const configured = memory.metadata.type;
  return typeof configured === "string" && configured.trim() ? configured.trim() : memory.scope;
}
