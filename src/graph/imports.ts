import * as ts from 'typescript';

/**
 * Finds every import path written in a JS or TS file.
 * @param source The full text of the file.
 * @returns The import paths, in the order the scanner reports them.
 */
export function scanImports(source: string): string[] {
	const readImports = true;
	const detectJavaScriptImports = true;
	const fileInfo = ts.preProcessFile(source, readImports, detectJavaScriptImports);
	return fileInfo.importedFiles.map((file) => file.fileName);
}