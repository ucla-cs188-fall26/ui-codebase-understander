import * as vscode from 'vscode';
import { posix } from 'path';
import { buildEdges, buildTree } from '../graph/build';
import { buildSignalEdges, FoundSignals, scanSignals } from '../graph/events';
import { CODE_EXTENSIONS, FoundImport, scanImports } from '../graph/imports';
import { Graph } from '../graph/types';

// directories that are generated or installed rather than written by hand
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out}/**';

/**
 * Builds the graph for a workspace folder.
 * @param workspaceFolder The workspace folder to scan.
 * @returns Every file and directory as nodes, and every file-to-file import, event and message as edges.
 */
export async function loadGraph(workspaceFolder: vscode.WorkspaceFolder): Promise<Graph> {
    const pattern = new vscode.RelativePattern(workspaceFolder, '**/*');
    const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB);

    const decoder = new TextDecoder();
    const importsByFile = new Map<string, FoundImport[]>();
    const signalsByFile = new Map<string, FoundSignals>();
    for (const uri of uris) {
        // repo-relative path with forward slashes, like src/graph/build.ts
        const path = vscode.workspace.asRelativePath(uri, false);

        // non-code files still become nodes, they just have no imports
        if (!CODE_EXTENSIONS.includes(posix.extname(path))) {
            importsByFile.set(path, []);
            continue;
        }

        const bytes = await vscode.workspace.fs.readFile(uri);
        const source = decoder.decode(bytes);
        importsByFile.set(path, scanImports(source));
        signalsByFile.set(path, scanSignals(source, path));
    }

    const nodes = buildTree(workspaceFolder.name, Array.from(importsByFile.keys()));
    // imports first, then events and messages, which link files that don't import each other
    const edges = buildEdges(importsByFile).concat(buildSignalEdges(signalsByFile));
    return { nodes: nodes, edges: edges };
}
