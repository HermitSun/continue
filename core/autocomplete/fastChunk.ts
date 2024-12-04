import { SyntaxNode } from "web-tree-sitter";
import { type AutocompleteSnippet } from "./ranking.js";
import { countTokensAsync } from "../llm/countTokens.js";
import { getParserForFile } from "../util/treeSitter.js";
import { appendLog } from "../../appendLog";

const MAX_BLOCK_SIZE = 2000;
const MIN_BLOCK_SIZE = 300;

function serializeSyntaxTree(node: SyntaxNode): object {
    if (node.endIndex - node.startIndex < 300){
        return {
            type: node.type, // 节点类型，例如 "class_declaration"
            startIndex: node.startIndex, // 起始字符位置
            endIndex: node.endIndex, // 结束字符位置
            children: "...", // 递归序列化子节点
        };
    }
    
    return {
        type: node.type, // 节点类型，例如 "class_declaration"
        startIndex: node.startIndex, // 起始字符位置
        endIndex: node.endIndex, // 结束字符位置
        children: node.children.map(serializeSyntaxTree), // 递归序列化子节点
    };
}

export async function* fastChunk(
    filepath: string,
    contents: string,
): AsyncGenerator<AutocompleteSnippet> {
    const parser = await getParserForFile(filepath);
    if (!parser) {
        // throw new Error(`Failed to load parser for file ${filepath}`);
        return undefined;
    }
    const tree = parser.parse(contents);
    // appendLog(
    //     "core/autocomplete/fastChunk.ts\n" +
    //     "fastChunk - tree.rootNode: " + JSON.stringify({...serializeSyntaxTree(tree.rootNode)}, null, 2) + "\n" +
    //     "fastChunk - contents: " + contents + "\n"
    // )
    for await (const chunk of processNode(filepath, tree.rootNode, contents)) {
        // appendLog(
        //     "core/autocomplete/fastChunk.ts\n" +
        //     "fastChunk - filepath: " + filepath + "\n" +
        //     "fastChunk - chunk: " + JSON.stringify({...chunk}, null, 2) + "\n"
        // )
        yield chunk;
    }
}
let collectedChunks: AutocompleteSnippet[] = [];
// 超过MIN_BLOCK_SIZE的省略
// 其他的正常显示
async function collapseLargeBlock(
    node: SyntaxNode,
    code: string,
    filepath: string
): Promise<string> {
    let classCode = code.slice(node.startIndex, node.endIndex);
    for (const child of node.children) {
        const childLength = child.endIndex - child.startIndex;
        if (childLength < MIN_BLOCK_SIZE) continue;
        else if (childLength > MAX_BLOCK_SIZE){
            classCode =
                classCode.slice(0, child.startIndex - node.startIndex) +
                await collapseLargeBlock(child, code, filepath) +
                classCode.slice(child.endIndex - node.startIndex);
        }else{
            collectedChunks.push({
                filepath: filepath,
                range: {
                    start: { line: child.startPosition.row, character: 0 },
                    end: { line: child.endPosition.row, character: 0 } 
                },
                contents: child.text
            });
            classCode =
                classCode.slice(0, child.startIndex - node.startIndex) +
                "{ ... }" +
                classCode.slice(child.endIndex - node.startIndex);
        }
    }
    return classCode;
}

async function* processNode(
    filepath: string,
    node: SyntaxNode,
    code: string,
): AsyncGenerator<AutocompleteSnippet> {
    const nodeLength = node.endIndex - node.startIndex;
    if (nodeLength > MAX_BLOCK_SIZE){
        collectedChunks = [];
        yield {
            filepath: filepath,
            range: {
                start: { line: node.startPosition.row, character: 0 },
                end: { line: node.endPosition.row, character: 0 } 
            },
            contents: await collapseLargeBlock(node, code, filepath)
        };
        for (const chunk of collectedChunks){
            yield chunk;
        }
    }else if (nodeLength > MIN_BLOCK_SIZE) {
        yield {
            filepath: filepath,
            range: {
                start: { line: node.startPosition.row, character: 0 },
                end: { line: node.endPosition.row, character: 0 } 
            },
            contents: node.text
        };
    }
}