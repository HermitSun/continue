import { RangeInFileWithContents } from "../commands/util.js";
import { TabAutocompleteOptions } from "../index.js";

import {
  countTokens,
  pruneLinesFromBottom,
  pruneLinesFromTop,
} from "../llm/countTokens.js";
import { AstPath, getAst, getTreePathAtCursor } from "./ast.js";
import {
  AutocompleteLanguageInfo,
  LANGUAGES,
  Typescript,
} from "./languages.js";
import {
  fillPromptWithSnippets,
  getSymbolsForSnippet,
  rankSnippets,
  removeRangeFromSnippets,
  type AutocompleteSnippet,
} from "./ranking.js";
import { RecentlyEditedRange, findMatchingRange } from "./recentlyEdited.js";
import { ImportDefinitionsService } from "./services/ImportDefinitionsService.js";
import { RootPathContextService } from "./services/RootPathContextService.js";
import { shouldCompleteMultiline } from "./shouldCompleteMultiline.js";
import { ConfigHandler } from "../config/ConfigHandler.js";
import { walkDirAsync } from "../indexing/walkDir.js";

export function languageForFilepath(
  filepath: string,
): AutocompleteLanguageInfo {
  return LANGUAGES[filepath.split(".").slice(-1)[0]] || Typescript;
}

import * as path from "path";
import { promises as fs } from 'fs';

/**
 * 递归获取指定目录及其子目录中的所有文件路径
 * @param directory - 目标目录的路径
 * @returns 文件路径列表
 */
export async function getFilesFromDirectory(directory: string): Promise<string[]> {
    const results: string[] = [];
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true }); // 获取目录内容
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name); // 拼接绝对路径
            if (entry.isDirectory()) {
                results.push(...await getFilesFromDirectory(fullPath)); // 递归处理子目录
            } else {
                results.push(fullPath); // 添加文件路径
            }
        }
    } catch (error) {
        console.error(`Error reading directory: ${directory}`, error);
    }
    return results;
}

async function readFileWithSizeCheck(filepath: string, maxSize: number): Promise<string> {
  try {
    const stats = await fs.stat(filepath); // 获取文件信息
    const fileSizeInBytes = stats.size; // 获取文件大小（字节）

    if (fileSizeInBytes < 10 * maxSize) {
      // 如果文件大于最大大小（1MB），只读取文件的前部分
      const buffer = Buffer.alloc(maxSize); // 创建一个缓冲区来存放文件的前部分内容
      const fd = await fs.open(filepath, 'r'); // 打开文件进行读取
      await fd.read(buffer, 0, maxSize, 0); // 从文件开始读取前 maxSize 字节
      await fd.close(); // 关闭文件描述符

      return buffer.toString('utf-8'); // 返回读取的内容
    } else {
      // 如果文件较小，直接读取整个文件
      return "";
    }
  } catch (error) {
    console.error(`读取文件 ${filepath} 时发生错误:`, error);
    return '';
  }
}


export async function constructAutocompletePrompt(
  filepath: string,
  cursorLine: number,
  fullPrefix: string,
  fullSuffix: string,
  clipboardText: string,
  language: AutocompleteLanguageInfo,
  options: TabAutocompleteOptions,
  recentlyEditedRanges: RecentlyEditedRange[],
  recentlyEditedFiles: RangeInFileWithContents[],
  modelName: string,
  extraSnippets: AutocompleteSnippet[],
  importDefinitionsService: ImportDefinitionsService,
  rootPathContextService: RootPathContextService,
  configHandler: ConfigHandler,
): Promise<{
  prefix: string;
  suffix: string;
  useFim: boolean;
  completeMultiline: boolean;
  snippets: AutocompleteSnippet[];
}>{
  const startTime = Date.now();
  // Construct basic prefix
  const maxPrefixTokens = options.maxPromptTokens * options.prefixPercentage;
  const prefix = pruneLinesFromTop(fullPrefix, maxPrefixTokens, modelName);
  
  // Construct suffix
  const maxSuffixTokens = Math.min(
    options.maxPromptTokens - countTokens(prefix, modelName),
    options.maxSuffixPercentage * options.maxPromptTokens,
  );
  const suffix = pruneLinesFromBottom(fullSuffix, maxSuffixTokens, modelName);

  // Calculate AST Path
  let treePath: AstPath | undefined;
  try {
    const ast = await getAst(filepath, fullPrefix + fullSuffix);
    if (ast) {
      treePath = await getTreePathAtCursor(ast, fullPrefix.length);
    }
  } catch (e) {
    console.error("Failed to parse AST", e);
  }
  
  const MAX_FILE_SIZE = 100000; // 100KB（字节）
  const ReadFileStartTime = Date.now();
  // Find external snippets
  let snippets: AutocompleteSnippet[] = [];
  const workspaceDirs = await configHandler.ide.getWorkspaceDirs();
  for (const directory of workspaceDirs) {
    for await (const p of await getFilesFromDirectory(directory)) {
      const ReadStartTime = Date.now();
      const fileContent: string = await readFileWithSizeCheck(p, MAX_FILE_SIZE);
      if (fileContent != ""){
        await snippets.push({
          filepath: p,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 } 
          },
          contents: fileContent
        });
      }
      
      const ReadTime = Date.now() - ReadStartTime;
    }
  }

  const ReadFileTime = Date.now() - ReadFileStartTime;
  await configHandler.logMessage(
    "core/autocomplete/constructPrompt.ts\n" +
    "constructAutocompletePrompt - snippets.length: " + snippets.length + "\n" +
    "constructAutocompletePrompt - ReadFileTime: " + ReadFileTime/1000 + "s\n" 
  );
  
  const windowAroundCursor =
    fullPrefix.slice(
      -options.slidingWindowSize * options.slidingWindowPrefixPercentage,
    ) +
    fullSuffix.slice(
      options.slidingWindowSize * (1 - options.slidingWindowPrefixPercentage),
    );
  const scoredSnippets = rankSnippets(snippets, windowAroundCursor);
  // Fill maxSnippetTokens with snippets
  const maxSnippetTokens =
  options.maxPromptTokens * options.maxSnippetPercentage;

  // Remove prefix range from snippets
  const prefixLines = prefix.split("\n").length;
  const suffixLines = suffix.split("\n").length;
  const buffer = 8;
  const prefixSuffixRangeWithBuffer = {
    start: {
      line: cursorLine - prefixLines - buffer,
      character: 0,
    },
    end: {
      line: cursorLine + suffixLines + buffer,
      character: 0,
    },
  };
  let finalSnippets = removeRangeFromSnippets(
    scoredSnippets,
    filepath.split("://").slice(-1)[0],
    prefixSuffixRangeWithBuffer,
  );

  // Filter snippets for those with best scores (must be above threshold)
  finalSnippets = finalSnippets.filter(
    (snippet) => snippet.score >= options.recentlyEditedSimilarityThreshold,
    );
    finalSnippets = fillPromptWithSnippets(
    scoredSnippets,
    maxSnippetTokens,
    modelName,
  );
  snippets = finalSnippets;

  const time = Date.now() - startTime;
  await configHandler.logMessage(
    "core/autocomplete/constructPrompt.ts\n" +
    "constructAutocompletePrompt - time: " + time/1000 + "s\n" +
    "constructAutocompletePrompt - snippets: " + JSON.stringify(snippets,null,2) + "\n" +
    "constructAutocompletePrompt - options: " + JSON.stringify({...options},null,2) + "\n"
  );

  return {
    prefix,
    suffix,
    useFim: true,
    completeMultiline: await shouldCompleteMultiline(
      treePath,
      fullPrefix,
      fullSuffix,
      language,
    ),
    snippets,
  };
}


export async function constructAutocompletePrompt_origin(
  filepath: string,
  cursorLine: number,
  fullPrefix: string,
  fullSuffix: string,
  clipboardText: string,
  language: AutocompleteLanguageInfo,
  options: TabAutocompleteOptions,
  recentlyEditedRanges: RecentlyEditedRange[],
  recentlyEditedFiles: RangeInFileWithContents[],
  modelName: string,
  extraSnippets: AutocompleteSnippet[],
  importDefinitionsService: ImportDefinitionsService,
  rootPathContextService: RootPathContextService,
  configHandler: ConfigHandler,
): Promise<{
  prefix: string;
  suffix: string;
  useFim: boolean;
  completeMultiline: boolean;
  snippets: AutocompleteSnippet[];
}> {
  // Construct basic prefix
  const maxPrefixTokens = options.maxPromptTokens * options.prefixPercentage;
  const prefix = pruneLinesFromTop(fullPrefix, maxPrefixTokens, modelName);
  
  // Construct suffix
  const maxSuffixTokens = Math.min(
    options.maxPromptTokens - countTokens(prefix, modelName),
    options.maxSuffixPercentage * options.maxPromptTokens,
  );
  const suffix = pruneLinesFromBottom(fullSuffix, maxSuffixTokens, modelName);
  configHandler.logMessage(
    "core/autocomplete/constructPrompt.ts\n" +
    "constructAutocompletePrompt - maxPrefixTokens: " + maxPrefixTokens + "\n" +
    "constructAutocompletePrompt - prefix: " + prefix + "\n" +
    "constructAutocompletePrompt - maxSuffixTokens: " + maxSuffixTokens + "\n" +
    "constructAutocompletePrompt - suffix: " + suffix + "\n"
  );
  // Calculate AST Path
  let treePath: AstPath | undefined;
  try {
    const ast = await getAst(filepath, fullPrefix + fullSuffix);
    if (ast) {
      treePath = await getTreePathAtCursor(ast, fullPrefix.length);
    }
  } catch (e) {
    console.error("Failed to parse AST", e);
  }

  // Find external snippets
  let snippets: AutocompleteSnippet[] = [];
  if (options.useOtherFiles) {
    snippets.push(...extraSnippets);
    const windowAroundCursor =
      fullPrefix.slice(
        -options.slidingWindowSize * options.slidingWindowPrefixPercentage,
      ) +
      fullSuffix.slice(
        options.slidingWindowSize * (1 - options.slidingWindowPrefixPercentage),
      );
    configHandler.logMessage(
      "core/autocomplete/constructPrompt.ts\n" +
      "constructAutocompletePrompt - extraSnippets: " + JSON.stringify({...extraSnippets}, null, 2) + "\n" +
      "constructAutocompletePrompt - windowAroundCursor: " + windowAroundCursor + "\n"
    );
    // This was much too slow, and not super useful
    // const slidingWindowMatches = await slidingWindowMatcher(
    //   recentlyEditedFiles,
    //   windowAroundCursor,
    //   3,
    //   options.slidingWindowSize,
    // );
    // snippets.push(...slidingWindowMatches);

    // snippets.push(
    //   ...recentlyEditedRanges.map((r) => ({
    //     ...r,
    //     contents: r.lines.join("\n"),
    //   })),
    // );

    if (options.useRecentlyEdited) {
      const currentLinePrefix = prefix.trim().split("\n").slice(-1)[0];
      configHandler.logMessage(
        "core/autocomplete/constructPrompt.ts\n" +
        "constructAutocompletePrompt - currentLinePrefix: " + currentLinePrefix + "\n" +
        "constructAutocompletePrompt - currentLinePrefix?.length: " + currentLinePrefix?.length + "\n" +
        "constructAutocompletePrompt - options.recentLinePrefixMatchMinLength: " + options.recentLinePrefixMatchMinLength + "\n"
      );
      if (currentLinePrefix?.length > options.recentLinePrefixMatchMinLength) {
        const matchingRange = findMatchingRange(
          recentlyEditedRanges,
          currentLinePrefix,
        );
        if (matchingRange) {
          snippets.push({
            ...matchingRange,
            contents: matchingRange.lines.join("\n"),
            score: 0.8,
          });
        }
        configHandler.logMessage(
          "core/autocomplete/constructPrompt.ts\n" +
          "constructAutocompletePrompt - recentlyEditedRanges: " + JSON.stringify({...recentlyEditedRanges}, null, 2) + "\n" +
          "constructAutocompletePrompt - matchingRange: " + JSON.stringify({...matchingRange}, null, 2) + "\n"
        );
      }
    }

    // Use imports
    if (options.useImports) {
      const importSnippets = [];
      const fileInfo = importDefinitionsService.get(filepath);
      if (fileInfo) {
        const { imports } = fileInfo;
        // Look for imports of any symbols around the current range
        const textAroundCursor =
          fullPrefix.split("\n").slice(-5).join("\n") +
          fullSuffix.split("\n").slice(0, 3).join("\n");
        const symbols = Array.from(
          getSymbolsForSnippet(textAroundCursor),
        ).filter((symbol) => !language.topLevelKeywords.includes(symbol));
        for (const symbol of symbols) {
          const rifs = imports[symbol];
          configHandler.logMessage(
            "core/autocomplete/constructPrompt.ts\n" +
            "constructAutocompletePrompt - rifs: " + JSON.stringify({...rifs}, null, 2) + "\n" 
          );
          if (Array.isArray(rifs)) {
            importSnippets.push(...rifs);
          }
        }
        configHandler.logMessage(
          "core/autocomplete/constructPrompt.ts\n" +
          "constructAutocompletePrompt - fileInfo: " + JSON.stringify({...fileInfo}, null, 2) + "\n" +
          "constructAutocompletePrompt - importSnippets: " + JSON.stringify({...importSnippets}, null, 2) + "\n" +
          "constructAutocompletePrompt - symbols: " + JSON.stringify({...symbols}, null, 2) + "\n"
        );
      }
      
      snippets.push(...importSnippets);
    }

    if (options.useRootPathContext && treePath) {
      const ctx = await rootPathContextService.getContextForPath(
        filepath,
        treePath,
      );
      configHandler.logMessage(
        "core/autocomplete/constructPrompt.ts\n" +
        "constructAutocompletePrompt - ctx: " + JSON.stringify({...ctx}, null, 2) + "\n"
      );
      snippets.push(...ctx);
    }

    // Filter out empty snippets and ones that are already in the prefix/suffix
    snippets = snippets
      .map((snippet) => ({ ...snippet }))
      .filter(
        (s) =>
          s.contents.trim() !== "" &&
          !(prefix + suffix).includes(s.contents.trim()),
      );

    // Rank / order the snippets
    const scoredSnippets = rankSnippets(snippets, windowAroundCursor);
    configHandler.logMessage(
      "core/autocomplete/constructPrompt.ts\n" +
      "constructAutocompletePrompt - scoredSnippets: " + JSON.stringify({...scoredSnippets}, null, 2) + "\n"
    );
    // Fill maxSnippetTokens with snippets
    const maxSnippetTokens =
      options.maxPromptTokens * options.maxSnippetPercentage;

    // Remove prefix range from snippets
    const prefixLines = prefix.split("\n").length;
    const suffixLines = suffix.split("\n").length;
    const buffer = 8;
    const prefixSuffixRangeWithBuffer = {
      start: {
        line: cursorLine - prefixLines - buffer,
        character: 0,
      },
      end: {
        line: cursorLine + suffixLines + buffer,
        character: 0,
      },
    };
    let finalSnippets = removeRangeFromSnippets(
      scoredSnippets,
      filepath.split("://").slice(-1)[0],
      prefixSuffixRangeWithBuffer,
    );
    
    // Filter snippets for those with best scores (must be above threshold)
    finalSnippets = finalSnippets.filter(
      (snippet) => snippet.score >= options.recentlyEditedSimilarityThreshold,
    );
    finalSnippets = fillPromptWithSnippets(
      scoredSnippets,
      maxSnippetTokens,
      modelName,
    );
    configHandler.logMessage(
      "core/autocomplete/constructPrompt.ts\n" +
      "constructAutocompletePrompt - finalSnippets: " + JSON.stringify({...finalSnippets}, null, 2) + "\n"
    );
    snippets = finalSnippets;
  }

  return {
    prefix,
    suffix,
    useFim: true,
    completeMultiline: await shouldCompleteMultiline(
      treePath,
      fullPrefix,
      fullSuffix,
      language,
    ),
    snippets,
  };
}
