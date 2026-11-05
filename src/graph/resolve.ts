import { posix } from 'path';

// tried in order, so .ts wins over .js when both exist
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

// other filenames to look for when a compiled file doesn't exist
const COMPILED_TO_SOURCE: Record<string, string[]> = {
	'.js': ['.ts', '.tsx'],
	'.jsx': ['.tsx'],
	'.mjs': ['.mts'],
	'.cjs': ['.cts'],
};

/**
 * Finds the repo file that an import path points to.
 * @param importPath The path as written in the code, like `./lib/b`.
 * @param fromFile The repo-relative path of the file containing the import.
 * @param files Every file path in the repo.
 * @returns The matching repo path, or undefined if it isn't in the repo.
 */
export function resolveImport(importPath: string, fromFile: string, files: Set<string>): string | undefined {
	// relative imports start with a dot, anything else is a package
	if (!importPath.startsWith('.')) {
		return undefined;
	}

	// repo path of the import, e.g. src + ./lib/b = src/lib/b
	const fromFolder = posix.dirname(fromFile);
	const basePath = posix.join(fromFolder, importPath);

	// import already has its full filename
	if (files.has(basePath)) {
		return basePath;
	}

	// ./b.js can mean b.ts, because b.js doesn't exist until the code is compiled
	const compiledExtension = posix.extname(basePath);
	const pathWithoutExtension = basePath.slice(0, basePath.length - compiledExtension.length);
	const sourceExtensions = COMPILED_TO_SOURCE[compiledExtension] ?? [];
	for (const sourceExtension of sourceExtensions) {
		const candidate = pathWithoutExtension + sourceExtension;
		if (files.has(candidate)) {
			return candidate;
		}
	}

	// import left off the extension, e.g. ./lib/b = src/lib/b.ts
	for (const extension of EXTENSIONS) {
		const candidate = basePath + extension;
		if (files.has(candidate)) {
			return candidate;
		}
	}

	// import is a folder, e.g. ./utils = src/utils/index.ts
	for (const extension of EXTENSIONS) {
		const candidate = posix.join(basePath, 'index' + extension);
		if (files.has(candidate)) {
			return candidate;
		}
	}

	// not a file in the repo
	return undefined;
}