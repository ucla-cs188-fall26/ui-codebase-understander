import * as ts from 'typescript';
import { Collector, lineOf, parseFile, walk } from './syntax';
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
 * several lines, that's the line the path is on, usually its last.
 * @param source The full text of the file.
 * @param path The file's path, so .tsx and .jsx files are read with their tags.
 * @returns The imports, in the order they're written.
 */
export function scanImports(source: string, path = 'file.ts'): FoundImport[] {
    const file = parseFile(source, path);
    const imports = importCollector(file);
    walk(file, [imports]);
    return imports.finish();
}

/**
 * Makes a collector for a file's imports, to find them while its syntax tree is walked: import and export ... from
 * statements, import x = require(...), require(...) and import(...) calls, import(...) types, and declare module './x'
 * in a module, wherever they're written. A path built at runtime, like require(name), can't be read without running
 * the code, so it's skipped.
 * @param file The file's syntax tree.
 * @returns The collector; its result is the imports, in the order they're written.
 */
export function importCollector(file: ts.SourceFile): Collector<FoundImport[]> {
    const found: FoundImport[] = [];

    // a file with imports or exports of its own is a module, where declare module './x' { ... } adds to another file's
    // types, so it depends on that file. Anywhere else it declares a module of its own, so it isn't an import
    const isModule = ts.isExternalModule(file);

    return {
        enter: function enter(node: ts.Node): void {
            let path = importedPath(node);
            if (isModule && ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
                path = node.name;
            }
            if (path !== undefined) {
                found.push({ path: path.text, lines: lineOf(file, path) });
            }
        },
        leave: function leave(): void {
            // nothing to do once a node's insides are walked
        },
        finish: function finish(): FoundImport[] {
            return found;
        },
    };
}

/**
 * Finds the path a node imports, if it's an import of some kind.
 * @param node Any node.
 * @returns The path as written, or undefined if the node isn't an import or its path isn't a plain string.
 */
function importedPath(node: ts.Node): ts.StringLiteral | undefined {
    // import x from './x', and export { x } from './x'
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
        return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier : undefined;
    }

    // import x = require('./x')
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression;
        return ts.isStringLiteral(expression) ? expression : undefined;
    }

    // a type from another file, like import('./x').Shape
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        return node.argument.literal;
    }

    // require('./x') and import('./x')
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
        const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        if (isImport || isRequire) {
            return node.arguments[0];
        }
    }
    return undefined;
}
