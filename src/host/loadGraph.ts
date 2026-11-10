import * as vscode from 'vscode';
import { posix } from 'path';
import { buildEdges, buildTree } from '../graph/build';
import { CODE_EXTENSIONS, scanImports } from '../graph/imports';
import { Graph } from '../graph/types';

// folders that are generated or installed rather than written by hand
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out}/**';

/**
 * Builds the graph for a workspace folder.
 * @param folder The folder to scan.
 * @returns Every file and folder as nodes, and every file-to-file import as edges.
 */
export async function loadGraph(folder: vscode.WorkspaceFolder): Promise<Graph> {
	const pattern = new vscode.RelativePattern(folder, '**/*');
	const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB);

	const decoder = new TextDecoder();
	const importsByFile = new Map<string, string[]>();
	for (const uri of uris) {
		// repo-relative path with forward slashes, like src/graph/build.ts
		const path = vscode.workspace.asRelativePath(uri, false);

		// non-code files still become nodes, they just have no imports
		if (!CODE_EXTENSIONS.includes(posix.extname(path))) {
			importsByFile.set(path, []);
			continue;
		}

		const bytes = await vscode.workspace.fs.readFile(uri);
		importsByFile.set(path, scanImports(decoder.decode(bytes)));
	}

	const nodes = buildTree(folder.name, Array.from(importsByFile.keys()));
	const edges = buildEdges(importsByFile);
	return { nodes: nodes, edges: edges };
}
