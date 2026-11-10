import { posix } from 'path';
import { resolveImport } from './resolve';
import { Edge, Node, ROOT_ID } from './types';

export function buildTree(repoName: string, paths: string[]): Node[] {
    // hashmap from Node.id to Node
	const nodes = new Map<string, Node>([
		[ROOT_ID, { 
            id: ROOT_ID, 
            kind: 'repo', 
            name: repoName, 
            parent: null, 
            path: ROOT_ID, 
            childCount: 0 
        }],
	]);

	function addNode(id: string, kind: 'directory' | 'file'): void {
		const parent = posix.dirname(id);

        // add parent Node to hm
		if (!nodes.has(parent)) {
			addNode(parent, 'directory');
		}

        // add Node to hm
		nodes.set(id, {
			id: id,
			kind: kind,
			name: posix.basename(id),
			parent: parent,
			path: id,
			childCount: 0,
		});
        
		nodes.get(parent)!.childCount++;
	}

	const sortedPaths = paths.toSorted();
	for (const path of sortedPaths) {
		addNode(path, 'file');
	}

	return Array.from(nodes.values());
}

/**
 * Turns each file's raw import paths into edges between repo files.
 * @param importsByFile Every repo file, mapped to the import paths written in it.
 * @returns One edge per file-to-file import. Packages get no edge.
 */
export function buildEdges(importsByFile: Map<string, string[]>): Edge[] {
	const files = new Set(importsByFile.keys());
	const sortedFiles = Array.from(files).toSorted();

	const edges: Edge[] = [];
	for (const fromFile of sortedFiles) {
		const importPaths = importsByFile.get(fromFile)!;
		const connectedFiles = new Set<string>();
		for (const importPath of importPaths) {
			const toFile = resolveImport(importPath, fromFile, files);

			// skip packages, self-imports, and repeat imports of the same file
			if (toFile === undefined || toFile === fromFile || connectedFiles.has(toFile)) {
				continue;
			}

			connectedFiles.add(toFile);
			edges.push({ from: fromFile, to: toFile, kind: 'import' });
		}
	}

	return edges;
}
