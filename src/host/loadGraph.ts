import * as vscode from 'vscode';
import { posix } from 'path';
import { buildEdges, buildTree } from '../graph/build';
import { buildSignalEdges, FoundSignals } from '../graph/events';
import { CODE_EXTENSIONS, FoundImport } from '../graph/imports';
import { scanFile } from '../graph/scan';
import { Graph } from '../graph/types';

// directories that are generated or installed rather than written by hand
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out}/**';

// how many files are read at once: enough to hide the wait on each read, which is long on a remote file system like
// SSH or a container, without asking for every file at the same moment
const READS_AT_ONCE = 32;

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
    const codeUris: vscode.Uri[] = [];
    for (const uri of uris) {
        // repo-relative path with forward slashes, like src/graph/build.ts
        const path = vscode.workspace.asRelativePath(uri, false);

        // non-code files still become nodes, they just have no imports
        if (!CODE_EXTENSIONS.includes(posix.extname(path))) {
            importsByFile.set(path, []);
            continue;
        }
        codeUris.push(uri);
    }

    // code files are read a batch at a time, then scanned one by one
    for (let start = 0; start < codeUris.length; start += READS_AT_ONCE) {
        const batch = codeUris.slice(start, start + READS_AT_ONCE);
        const contents = await Promise.all(batch.map(readFile));
        for (let i = 0; i < batch.length; i++) {
            const path = vscode.workspace.asRelativePath(batch[i], false);

            // read once, for everything found in it
            const scan = scanFile(decoder.decode(contents[i]), path);
            importsByFile.set(path, scan.imports);
            signalsByFile.set(path, scan.signals);
        }
    }

    const nodes = buildTree(workspaceFolder.name, Array.from(importsByFile.keys()));
    // imports first, then events and messages, which link files that don't import each other
    const edges = buildEdges(importsByFile).concat(buildSignalEdges(signalsByFile));
    return { nodes: nodes, edges: edges };
}

/**
 * Reads a file's bytes through VS Code, which also works for files on a remote machine.
 * @param uri The file.
 * @returns Its bytes, once read.
 */
function readFile(uri: vscode.Uri): Thenable<Uint8Array> {
    return vscode.workspace.fs.readFile(uri);
}
