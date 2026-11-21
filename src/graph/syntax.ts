import * as ts from 'typescript';
import { posix } from 'path';
import { LineRange } from './types';

// reading a code file once: parsing it into a syntax tree, and walking the tree once while collectors pick out what
// they need, like imports or events, so each file is read and parsed only one time however much is found in it

// something that picks facts out of a syntax tree while it's walked
export interface Collector<Result> {
    enter(node: ts.Node): void; // called for each node, before the nodes inside it
    leave(node: ts.Node): void; // called after the nodes inside it
    finish(): Result; // called once the walk is done, for what it found
}

/**
 * Parses a JS or TS file into a syntax tree.
 * @param source The full text of the file.
 * @param path The file's path, so .tsx and .jsx files are read with their tags.
 * @returns The tree.
 */
export function parseFile(source: string, path: string): ts.SourceFile {
    const extension = posix.extname(path);
    const hasTags = extension === '.tsx' || extension === '.jsx';
    const scriptKind = hasTags ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const setParentNodes = false;

    // doc comments aren't read into the tree, which makes parsing about a third faster; nothing collected uses them
    const options = { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone };
    return ts.createSourceFile(path, source, options, setParentNodes, scriptKind);
}

/**
 * Walks a syntax tree once, in the order the code is written, handing every node to every collector.
 * @param file The tree, from parseFile.
 * @param collectors What to hand the nodes to; each sees every node.
 */
export function walk(file: ts.SourceFile, collectors: Collector<unknown>[]): void {
    function visit(node: ts.Node): void {
        for (const collector of collectors) {
            collector.enter(node);
        }
        ts.forEachChild(node, visit);
        for (const collector of collectors) {
            collector.leave(node);
        }
    }
    visit(file);
}

/**
 * Finds the line a node starts on.
 * @param file The tree it's in.
 * @param node The node.
 * @returns Its first line, 1-based, as a range of one line.
 */
export function lineOf(file: ts.SourceFile, node: ts.Node): LineRange {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    return { start: line, end: line };
}
