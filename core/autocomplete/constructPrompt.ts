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
import {
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_FILETYPES,
  defaultIgnoreDir,
  defaultIgnoreFile,
  gitIgArrayFromFile,
} from "../indexing/ignore.js";
import { appendLog } from "../../appendLog";
import * as path from "path";
import { promises as fs } from 'fs';
import { fastChunk } from './fastChunk';
import { chunkDocument } from "../indexing/chunk/chunk.js";


const MAX_FILE_SIZE = 30000; // 100KB（字节）
const MAX_FILE_NUMBER = 20;
// 忽略目录正则表达式：匹配所有以忽略目录开头的路径
const DEFAULT_IGNORE_DIRS_REGEX = new RegExp(
  DEFAULT_IGNORE_DIRS.map((dir) => 
    `(^|/)${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
  ).join("|")
);
// 忽略文件类型正则表达式：匹配特定的文件名或扩展名
const DEFAULT_IGNORE_FILETYPES_REGEX = new RegExp(
  DEFAULT_IGNORE_FILETYPES.map((type) => 
    type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")
  ).join("|")
);  


export function languageForFilepath(
  filepath: string,
): AutocompleteLanguageInfo {
  return LANGUAGES[filepath.split(".").slice(-1)[0]] || Typescript;
}

async function findFilesUpwards(startPath: string, maxFiles: number = 100): Promise<string[]> {
  const resultFiles: string[] = [];
  const visitedDirs = new Set<string>();

  /**
   * 遍历指定目录及其所有子目录中的文件
   */
  async function traverseDirectory(directory: string) {
    if (resultFiles.length >= maxFiles || visitedDirs.has(directory)) {
      return;
    }
    visitedDirs.add(directory); 
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        
        if (entry.isFile()) {
          // 检查是否是需要忽略的文件类型（匹配文件名或扩展名）
          if (DEFAULT_IGNORE_FILETYPES_REGEX.test(path.basename(fullPath))) {
            continue;
          }
          if (fullPath === startPath && !resultFiles.includes(fullPath)) {
            resultFiles.push(fullPath);
          } else if (fullPath !== startPath) {
            resultFiles.push(fullPath);
          }
          
          if (resultFiles.length >= maxFiles) {
            return;
          }
        } else if (entry.isDirectory()) {
          // 检查是否是需要忽略的目录（匹配完整路径）
          if (DEFAULT_IGNORE_DIRS_REGEX.test(fullPath)) {
            continue;
          }
          await traverseDirectory(fullPath);
        }
      }
    } catch (err) {
      console.error(`Error reading directory ${directory}:`, err);
    }
  }

  let currentDir = path.dirname(startPath);
  while (currentDir && resultFiles.length < maxFiles) {
    await traverseDirectory(currentDir);

    const parentDir = path.resolve(currentDir, "..");
    if (parentDir === currentDir) {
      break; 
    }
    currentDir = parentDir;
  }
  return resultFiles.slice(0, maxFiles);
}
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
      if (fileSizeInBytes <= maxSize) {
        return await fs.readFile(filepath, 'utf-8');
      } else {
        const buffer = Buffer.alloc(maxSize); // 创建一个缓冲区来存放文件的前部分内容
        const fd = await fs.open(filepath, 'r'); // 打开文件进行读取
        await fd.read(buffer, 0, maxSize, 0); // 从文件开始读取前 maxSize 字节
        await fd.close(); // 关闭文件描述符
        return buffer.toString('utf-8'); // 返回读取的内容
      }
    } else {
      return "";
    }
  } catch (error) {
    console.error(`读取文件 ${filepath} 时发生错误:`, error);
    return '';
  }
}

async function compareChunkTime (
  filepath: string,
  configHandler: ConfigHandler,
){
  // Find external snippets
  let snippets: AutocompleteSnippet[] = [];
  const FastChunkStartTime = Date.now();
  let fileNumber = 0;
  for await (const p of await findFilesUpwards(filepath, MAX_FILE_NUMBER)) {
    fileNumber = fileNumber + 1;
    const fileContent: string = await readFileWithSizeCheck(p, MAX_FILE_SIZE);
    if (fileContent != ""){
      for await (const chunk of fastChunk(p, fileContent)) {
        if (chunk){
          snippets.push(chunk);
        }
      }
    }
  }
  const FastChunkTime = Date.now() - FastChunkStartTime;
  await configHandler.logMessage(
    "core/autocomplete/constructPrompt.ts\n" +
    "constructAutocompletePrompt - fileNumber: " + fileNumber + "\n" +
    "constructAutocompletePrompt - snippets.length: " + snippets.length + "\n" +
    "constructAutocompletePrompt - FastChunkTime: " + FastChunkTime/1000 + "s\n"
  );

  let chunkNumber = 0;
  const chunkDocumentStartTime = Date.now();
  for await (const p of await findFilesUpwards(filepath, MAX_FILE_NUMBER)) {
    const fileContent: string = await readFileWithSizeCheck(p, MAX_FILE_SIZE);
    if (fileContent != "" && fileContent != undefined){
      const chunkParams = {
        filepath: p,
        contents: fileContent,
        maxChunkSize: 512,
        digest: "",
      }
      for await (const chunk of chunkDocument(chunkParams)) {
        if (chunk){
          chunkNumber = chunkNumber + 1;
        }
      }
    }
  }
  const chunkDocumentTime = Date.now() - chunkDocumentStartTime;
  await configHandler.logMessage(
    "core/autocomplete/constructPrompt.ts\n" +
    "constructAutocompletePrompt - fileNumber: " + fileNumber + "\n" +
    "constructAutocompletePrompt - snippets.length: " + chunkNumber + "\n" +
    "constructAutocompletePrompt - chunkDocumentTime: " + chunkDocumentTime/1000 + "s\n"
  );
}


export async function constructAutocompletePrompt_v2(
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
  
  compareChunkTime (filepath, configHandler);
  // Find external snippets
  let snippets: AutocompleteSnippet[] = [];

  const FastChunkStartTime = Date.now();
  for await (const p of await findFilesUpwards(filepath, MAX_FILE_NUMBER)) {
    const fileContent: string = await readFileWithSizeCheck(p, MAX_FILE_SIZE);
    if (fileContent != ""){
      for await (const chunk of fastChunk(p, fileContent)) {
        if (chunk){
          snippets.push(chunk);
          // appendLog(
          //   "core/autocomplete/constructPrompt.ts\n" +
          //   "constructAutocompletePrompt - p: " + p + "\n" +
          //   "constructAutocompletePrompt - chunk: " + JSON.stringify({...chunk}, null, 2) + "\n" 
          // );
        }
      }
    }
  }
  const FastChunkTime = Date.now() - FastChunkStartTime;
  await configHandler.logMessage(
    "core/autocomplete/constructPrompt.ts\n" +
    "constructAutocompletePrompt - snippets.length: " + snippets.length + "\n" +
    "constructAutocompletePrompt - FastChunkTime: " + FastChunkTime/1000 + "s\n"
  );
  
  
  const windowAroundCursor =
    fullPrefix.slice(
      -options.slidingWindowSize * options.slidingWindowPrefixPercentage,
    ) +
    fullSuffix.slice(
      options.slidingWindowSize * (1 - options.slidingWindowPrefixPercentage),
    );
  const RankStartTime = Date.now();
  const scoredSnippets = rankSnippets(snippets, windowAroundCursor);
  const RankTime = Date.now() - RankStartTime;
  await configHandler.logMessage(
    "core/autocomplete/constructPrompt.ts\n" +
    "constructAutocompletePrompt - RankTime: " + RankTime/1000 + "s\n" 
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
  snippets = finalSnippets;

  const time = Date.now() - startTime;
  await configHandler.logMessage(
    "core/autocomplete/constructPrompt.ts\n" +
    "constructAutocompletePrompt - time: " + time/1000 + "s\n" +
    "constructAutocompletePrompt - maxSnippetTokens: " + maxSnippetTokens + "\n" +
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
}> {
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
    // 1. extraSnippets
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

    // 2. 目录树上文件片段
    const FastChunkStartTime = Date.now();
    for await (const p of await findFilesUpwards(filepath, MAX_FILE_NUMBER)) {
      const fileContent: string = await readFileWithSizeCheck(p, MAX_FILE_SIZE);
      if (fileContent != ""){
        for await (const chunk of fastChunk(p, fileContent)) {
          if (chunk){
            snippets.push(chunk);
            // appendLog(
            //   "core/autocomplete/constructPrompt.ts\n" +
            //   "constructAutocompletePrompt - p: " + p + "\n" +
            //   "constructAutocompletePrompt - chunk: " + JSON.stringify({...chunk}, null, 2) + "\n" 
            // );
          }
        }
      }
    }
    const FastChunkTime = Date.now() - FastChunkStartTime;
    await configHandler.logMessage(
      "core/autocomplete/constructPrompt.ts\n" +
      "constructAutocompletePrompt - snippets.length: " + snippets.length + "\n" +
      "constructAutocompletePrompt - FastChunkTime: " + FastChunkTime/1000 + "s\n"
    );

    // 3. 最近编辑过的文件
    if (options.useRecentlyEdited) {
      // for (const key in recentlyEditedRanges) {
      //   const recentlyEditedRange =  recentlyEditedRanges[key];
      //   snippets.push({
      //     ...recentlyEditedRange,
      //     contents: recentlyEditedRange.lines.join("\n"),
      //     // score: 0.8,
      //   });
      // }
      // configHandler.logMessage(
      //   "core/autocomplete/constructPrompt.ts\n" +
      //   "constructAutocompletePrompt - recentlyEditedRanges: " + JSON.stringify({...recentlyEditedRanges}, null, 2) + "\n" 
      // );
      // 选择与前缀相同的最近删除过的代码
      const currentLinePrefix = prefix.trim().split("\n").slice(-1)[0];
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
      }
    }

    // 4. Use imports
    if (options.useImports) {
      const importSnippets = [];
      const fileInfo = importDefinitionsService.get(filepath);
      if (fileInfo) {
        const { imports } = fileInfo;
        // for (const imported of imports){
        //   importSnippets.push(...imported);
        // }
        // configHandler.logMessage(
        //   "core/autocomplete/constructPrompt.ts\n" +
        //   "constructAutocompletePrompt - importSnippets: " + JSON.stringify({...importSnippets}, null, 2) + "\n" 
        // );

        // Look for imports of any symbols around the current range
        const textAroundCursor =
          fullPrefix.split("\n").slice(-5).join("\n") +
          fullSuffix.split("\n").slice(0, 3).join("\n");
        const symbols = Array.from(
          getSymbolsForSnippet(textAroundCursor),
        ).filter((symbol) => !language.topLevelKeywords.includes(symbol));
        for (const symbol of symbols) {
          const rifs = imports[symbol];
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

    // 5. context 信息
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
    const RankStartTime = Date.now();
    const scoredSnippets = rankSnippets(snippets, windowAroundCursor);
    const RankTime = Date.now() - RankStartTime;
    await configHandler.logMessage(
      "core/autocomplete/constructPrompt.ts\n" +
      "constructAutocompletePrompt - RankTime: " + RankTime/1000 + "s\n" +
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
    snippets = finalSnippets;
  }
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
