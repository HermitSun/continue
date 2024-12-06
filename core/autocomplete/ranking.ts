import { RangeInFileWithContents } from "../commands/util.js";
import { Range } from "../index.js";
import { countTokens } from "../llm/countTokens.js";
import { ConfigHandler } from "../config/ConfigHandler.js";

export type AutocompleteSnippet = RangeInFileWithContents & {
  score?: number;
};

const rx = /[\s.,\/#!$%\^&\*;:{}=\-_~()\[\]]/g;
export function getSymbolsForSnippet(snippet: string): Set<string> {
  const symbols = snippet
    .split(rx)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return new Set(symbols);
}

const symbolRegex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
export function getSymbolsForSnippet_fast(snippet: string): Set<string> {
  const symbols = new Set<string>();
  const matches  = snippet.matchAll(symbolRegex);
  for (const match of matches) {
    symbols.add(match[0]);
  }
  return symbols;
}

/**
 * Calculate similarity as number of shared symbols divided by total number of unique symbols between both.
 */
export function jaccardSimilarity(a: string, b: string, configHandler: ConfigHandler): number {
  // const startGetSymbolTime = Date.now();
  const aSet = getSymbolsForSnippet_fast(a);
  const bSet = getSymbolsForSnippet_fast(b);
  // const GetSymbolTime = Date.now() - startGetSymbolTime;

  // const startSetTime = Date.now();
  const union = new Set([...aSet, ...bSet]).size;
  // const SetTime = Date.now() - startSetTime;
  // configHandler.logMessage(
  //   "core/autocomplete/ranking.ts\n" +
  //   "jaccardSimilarity - SetTime: " + SetTime/1000 + "s\n" +
  //   "jaccardSimilarity - GetSymbolTime: " + GetSymbolTime/1000 + "s\n" +
  //   "jaccardSimilarity - aSet.size: " + aSet.size + "\n" +
  //   "jaccardSimilarity - bSet.size: " + bSet.size + "\n" 
  // );

  // Avoid division by zero
  if (union === 0) {
    return 0;
  }
  let intersection = 0;
  for (const symbol of aSet) {
    if (bSet.has(symbol)) {
      intersection++;
    }
  }
  return intersection / union;
}

/**
 * Rank code snippets to be used in tab-autocomplete prompt. Returns a sorted version of the snippet array.
 */
export function rankSnippets(
  ranges: AutocompleteSnippet[],
  windowAroundCursor: string,
  configHandler: ConfigHandler,
): Required<AutocompleteSnippet>[] {
  // const startTime = Date.now();
  const snippets: Required<AutocompleteSnippet>[] = ranges.map((snippet) => ({
    score:
      snippet.score ?? jaccardSimilarity(snippet.contents, windowAroundCursor, configHandler),
    ...snippet,
  }));
  // const Time = Date.now() - startTime;
  // configHandler.logMessage(
  //   "core/autocomplete/ranking.ts\n" +
  //   "constructAutocompletePrompt - jaccardSimilarityTime: " + Time/1000 + "s\n" 
  // );
  const uniqueSnippets = deduplicateSnippets(snippets);
  return uniqueSnippets.sort((a, b) => b.score - a.score);
}

/**
 * Deduplicate code snippets by merging overlapping ranges into a single range.
 */
export function deduplicateSnippets(
  snippets: Required<AutocompleteSnippet>[],
): Required<AutocompleteSnippet>[] {
  // Group by file
  const fileGroups: { [key: string]: Required<AutocompleteSnippet>[] } = {};
  for (const snippet of snippets) {
    if (!fileGroups[snippet.filepath]) {
      fileGroups[snippet.filepath] = [];
    }
    fileGroups[snippet.filepath].push(snippet);
  }

  // Merge overlapping ranges
  const allRanges = [];
  for (const file of Object.keys(fileGroups)) {
    allRanges.push(...mergeSnippetsByRange(fileGroups[file]));
  }
  return allRanges;
}

function mergeSnippetsByRange(
  snippets: Required<AutocompleteSnippet>[],
): Required<AutocompleteSnippet>[] {
  if (snippets.length <= 1) {
    return snippets;
  }

  const sorted = snippets.sort(
    (a, b) => a.range.start.line - b.range.start.line,
  );
  const merged: Required<AutocompleteSnippet>[] = [];

  while (sorted.length > 0) {
    const next = sorted.shift()!;
    const last = merged[merged.length - 1];
    if (merged.length > 0 && last.range.end.line >= next.range.start.line) {
      // Merge with previous snippet
      last.score = Math.max(last.score, next.score);
      try {
        last.range.end = next.range.end;
      } catch (e) {
        console.log("Error merging ranges", e);
      }
      last.contents = mergeOverlappingRangeContents(last, next);
    } else {
      merged.push(next);
    }
  }

  return merged;
}

function mergeOverlappingRangeContents(
  first: RangeInFileWithContents,
  second: RangeInFileWithContents,
): string {
  const firstLines = first.contents.split("\n");
  const numOverlapping = first.range.end.line - second.range.start.line;
  return `${firstLines.slice(-numOverlapping).join("\n")}\n${second.contents}`;
}

/**
 * Fill the allowed space with snippets
 */
export function fillPromptWithSnippets(
  snippets: Required<AutocompleteSnippet>[],
  maxSnippetTokens: number,
  modelName: string,
): Required<AutocompleteSnippet>[] {
  let tokensRemaining = maxSnippetTokens;
  const keptSnippets: Required<AutocompleteSnippet>[] = [];
  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i];
    const tokenCount = countTokens(snippet.contents, modelName);
    if (tokensRemaining - tokenCount >= 0) {
      tokensRemaining -= tokenCount;
      keptSnippets.push(snippet);
    } else {
      // 用换行符切分 snippet，填充 keptSnippets， 直到剩余 tokens 不足
      const lines = snippet.contents.split('\n');
      let partialContents = '';
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        const lineTokenCount = countTokens(line, modelName);
        if (tokensRemaining - lineTokenCount >= 0) {
          tokensRemaining -= lineTokenCount;
          partialContents += (partialContents ? '\n' : '') + line;
        } else {
          break;
        }
      }
      if (partialContents) {
        keptSnippets.push({ ...snippet, contents: partialContents });
      }
      break;

    }
  }
  return keptSnippets;
}

function rangeIntersectionByLines(a: Range, b: Range): Range | null {
  const startLine = Math.max(a.start.line, b.start.line);
  const endLine = Math.min(a.end.line, b.end.line);
  if (startLine >= endLine) {
    return null;
  }
  return {
    start: {
      line: startLine,
      character: 0,
    },
    end: {
      line: endLine,
      character: 0,
    },
  };
}

/**
 * Remove one range from another range, which may lead to returning two disjoint ranges
 */
function rangeDifferenceByLines(orig: Range, remove: Range): Range[] {
  if (
    orig.start.line >= remove.start.line &&
    orig.end.line <= remove.end.line
  ) {
    // / | | /
    return [];
  }
  if (
    orig.start.line <= remove.start.line &&
    orig.end.line >= remove.end.line
  ) {
    // | / / |
    // Splits the range
    return [
      {
        start: orig.start,
        end: remove.start,
      },
      {
        start: remove.end,
        end: orig.end,
      },
    ];
  }
  if (
    orig.start.line >= remove.start.line &&
    orig.end.line >= remove.end.line
  ) {
    // \ | / |
    return [
      {
        start: remove.end,
        end: orig.end,
      },
    ];
  }
  if (
    orig.start.line <= remove.start.line &&
    orig.end.line <= remove.end.line
  ) {
    // | / | /
    return [
      {
        start: orig.start,
        end: remove.start,
      },
    ];
  }
  return [orig];
}

export function removeRangeFromSnippets(
  snippets: Required<AutocompleteSnippet>[],
  filepath: string,
  range: Range,
): Required<AutocompleteSnippet>[] {
  const finalSnippets: Required<AutocompleteSnippet>[] = [];
  for (const snippet of snippets) {
    if (snippet.filepath !== filepath) {
      finalSnippets.push(snippet);
      continue;
    }

    const intersection = rangeIntersectionByLines(range, snippet.range);
    if (!intersection) {
      finalSnippets.push(snippet);
      
    } else {
      finalSnippets.push(
        ...rangeDifferenceByLines(snippet.range, intersection).map((range) => ({
          ...snippet,
          range,
        })),
      );
    }
  }

  return finalSnippets;
}

