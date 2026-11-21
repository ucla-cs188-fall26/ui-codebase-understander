import * as ts from 'typescript';
import { LineRange } from './types';

// files that can contain imports, in the order the resolver tries them
export const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

// an import path, and the lines it's written on
export interface FoundImport {
    path: string;
    lines: LineRange;
}

/**
 * Finds every import path written in a JS or TS file, and the line each path is on. For an import written across
 * several lines, that's its last line, where the path is; finding where it starts needs a full parse, which can come
 * with function nodes.
 * @param source The full text of the file.
 * @returns The imports, in the order they're written.
 */
export function scanImports(source: string): FoundImport[] {
    const readImports = true;
    const detectJavaScriptImports = true;
    const fileInfo = ts.preProcessFile(source, readImports, detectJavaScriptImports);

    // in the order they're written, so the line breaks before each are counted in one pass through the text
    const references = fileInfo.importedFiles.toSorted(function byPosition(a: ts.FileReference, b: ts.FileReference): number {
        return a.pos - b.pos;
    });
    const found: FoundImport[] = [];
    let line = 1;
    let counted = 0;
    for (const reference of references) {
        for (let i = counted; i < reference.pos; i++) {
            if (source[i] === '\n') {
                line++;
            }
        }
        counted = reference.pos;
        found.push({ path: reference.fileName, lines: { start: line, end: line } });
    }
    return found;
}