// TypeScript port of NLTK 3.8.1 PorterStemmer in its default
// NLTK_EXTENSIONS mode. NLTK is Apache-2.0 licensed. The upstream implementation
// follows Martin Porter's "An algorithm for suffix stripping" (1980), with the
// documented NLTK extensions required by LoCoMo's pinned scorer.

type Rule = readonly [suffix: string, replacement: string, condition?: (stem: string) => boolean];

const irregularForms = new Map<string, string>([
  ["sky", "sky"],
  ["skies", "sky"],
  ["dying", "die"],
  ["lying", "lie"],
  ["tying", "tie"],
  ["news", "news"],
  ["innings", "inning"],
  ["inning", "inning"],
  ["outings", "outing"],
  ["outing", "outing"],
  ["cannings", "canning"],
  ["canning", "canning"],
  ["howe", "howe"],
  ["proceed", "proceed"],
  ["exceed", "exceed"],
  ["succeed", "succeed"],
]);

const vowels = new Set(["a", "e", "i", "o", "u"]);

function isConsonant(word: string, index: number): boolean {
  if (vowels.has(word[index])) return false;
  if (word[index] === "y") return index === 0 ? true : !isConsonant(word, index - 1);
  return true;
}

function measure(stem: string): number {
  let count = 0;
  let previous = "";
  for (let index = 0; index < stem.length; index += 1) {
    const current = isConsonant(stem, index) ? "c" : "v";
    if (previous === "v" && current === "c") count += 1;
    previous = current;
  }
  return count;
}

function containsVowel(stem: string): boolean {
  for (let index = 0; index < stem.length; index += 1) {
    if (!isConsonant(stem, index)) return true;
  }
  return false;
}

function endsDoubleConsonant(word: string): boolean {
  return word.length >= 2 && word.at(-1) === word.at(-2) && isConsonant(word, word.length - 1);
}

function endsCvc(word: string): boolean {
  return (
    (word.length >= 3 &&
      isConsonant(word, word.length - 3) &&
      !isConsonant(word, word.length - 2) &&
      isConsonant(word, word.length - 1) &&
      !["w", "x", "y"].includes(word.at(-1) ?? "")) ||
    (word.length === 2 && !isConsonant(word, 0) && isConsonant(word, 1))
  );
}

function replaceSuffix(word: string, suffix: string, replacement: string): string {
  return suffix ? `${word.slice(0, -suffix.length)}${replacement}` : `${word}${replacement}`;
}

function applyRules(word: string, rules: readonly Rule[]): string {
  for (const [suffix, replacement, condition] of rules) {
    if (suffix === "*d" && endsDoubleConsonant(word)) {
      const stem = word.slice(0, -2);
      return !condition || condition(stem) ? `${stem}${replacement}` : word;
    }
    if (!word.endsWith(suffix)) continue;
    const stem = replaceSuffix(word, suffix, "");
    return !condition || condition(stem) ? `${stem}${replacement}` : word;
  }
  return word;
}

function positiveMeasure(stem: string): boolean {
  return measure(stem) > 0;
}

function step1a(word: string): string {
  if (word.endsWith("ies") && word.length === 4) return replaceSuffix(word, "ies", "ie");
  return applyRules(word, [
    ["sses", "ss"],
    ["ies", "i"],
    ["ss", "ss"],
    ["s", ""],
  ]);
}

function step1b(word: string): string {
  if (word.endsWith("ied")) return replaceSuffix(word, "ied", word.length === 4 ? "ie" : "i");
  if (word.endsWith("eed")) {
    const stem = replaceSuffix(word, "eed", "");
    return measure(stem) > 0 ? `${stem}ee` : word;
  }
  let intermediateStem: string | undefined;
  for (const suffix of ["ed", "ing"]) {
    if (!word.endsWith(suffix)) continue;
    const stem = replaceSuffix(word, suffix, "");
    if (containsVowel(stem)) {
      intermediateStem = stem;
      break;
    }
  }
  if (!intermediateStem) return word;
  const finalCharacter = intermediateStem.at(-1) ?? "";
  return applyRules(intermediateStem, [
    ["at", "ate"],
    ["bl", "ble"],
    ["iz", "ize"],
    ["*d", finalCharacter, () => !["l", "s", "z"].includes(finalCharacter)],
    ["", "e", (stem) => measure(stem) === 1 && endsCvc(stem)],
  ]);
}

function step1c(word: string): string {
  return applyRules(word, [
    ["y", "i", (stem) => stem.length > 1 && isConsonant(stem, stem.length - 1)],
  ]);
}

function step2(word: string): string {
  if (word.endsWith("alli")) {
    const stem = replaceSuffix(word, "alli", "");
    if (positiveMeasure(stem)) return step2(replaceSuffix(word, "alli", "al"));
  }
  return applyRules(word, [
    ["ational", "ate", positiveMeasure],
    ["tional", "tion", positiveMeasure],
    ["enci", "ence", positiveMeasure],
    ["anci", "ance", positiveMeasure],
    ["izer", "ize", positiveMeasure],
    ["bli", "ble", positiveMeasure],
    ["alli", "al", positiveMeasure],
    ["entli", "ent", positiveMeasure],
    ["eli", "e", positiveMeasure],
    ["ousli", "ous", positiveMeasure],
    ["ization", "ize", positiveMeasure],
    ["ation", "ate", positiveMeasure],
    ["ator", "ate", positiveMeasure],
    ["alism", "al", positiveMeasure],
    ["iveness", "ive", positiveMeasure],
    ["fulness", "ful", positiveMeasure],
    ["ousness", "ous", positiveMeasure],
    ["aliti", "al", positiveMeasure],
    ["iviti", "ive", positiveMeasure],
    ["biliti", "ble", positiveMeasure],
    ["fulli", "ful", positiveMeasure],
    ["logi", "log", () => positiveMeasure(word.slice(0, -3))],
  ]);
}

function step3(word: string): string {
  return applyRules(word, [
    ["icate", "ic", positiveMeasure],
    ["ative", "", positiveMeasure],
    ["alize", "al", positiveMeasure],
    ["iciti", "ic", positiveMeasure],
    ["ical", "ic", positiveMeasure],
    ["ful", "", positiveMeasure],
    ["ness", "", positiveMeasure],
  ]);
}

function step4(word: string): string {
  const measureGreaterThanOne = (stem: string) => measure(stem) > 1;
  return applyRules(word, [
    ["al", "", measureGreaterThanOne],
    ["ance", "", measureGreaterThanOne],
    ["ence", "", measureGreaterThanOne],
    ["er", "", measureGreaterThanOne],
    ["ic", "", measureGreaterThanOne],
    ["able", "", measureGreaterThanOne],
    ["ible", "", measureGreaterThanOne],
    ["ant", "", measureGreaterThanOne],
    ["ement", "", measureGreaterThanOne],
    ["ment", "", measureGreaterThanOne],
    ["ent", "", measureGreaterThanOne],
    ["ion", "", (stem) => measure(stem) > 1 && ["s", "t"].includes(stem.at(-1) ?? "")],
    ["ou", "", measureGreaterThanOne],
    ["ism", "", measureGreaterThanOne],
    ["ate", "", measureGreaterThanOne],
    ["iti", "", measureGreaterThanOne],
    ["ous", "", measureGreaterThanOne],
    ["ive", "", measureGreaterThanOne],
    ["ize", "", measureGreaterThanOne],
  ]);
}

function step5a(word: string): string {
  if (!word.endsWith("e")) return word;
  const stem = replaceSuffix(word, "e", "");
  if (measure(stem) > 1 || (measure(stem) === 1 && !endsCvc(stem))) return stem;
  return word;
}

function step5b(word: string): string {
  return applyRules(word, [["ll", "l", () => measure(word.slice(0, -1)) > 1]]);
}

export function nltkPorterStem(value: string): string {
  const word = value.toLocaleLowerCase("en-US");
  const irregular = irregularForms.get(word);
  if (irregular) return irregular;
  if (word.length <= 2) return word;
  return step5b(step5a(step4(step3(step2(step1c(step1b(step1a(word))))))));
}
