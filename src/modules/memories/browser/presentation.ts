import type { Memory } from "@corespeed/lore-sdk";

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

const PREFERRED_TYPE_ORDER = ["concept", "product", "person", "company"];

export function typeLabel(type: string): string {
  return (type.trim() || "other").replace(/[_-]/g, " ");
}

export function typeSort(a: string, b: string): number {
  const ai = PREFERRED_TYPE_ORDER.indexOf(a);
  const bi = PREFERRED_TYPE_ORDER.indexOf(b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  return a.localeCompare(b);
}
