import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { loadGraph } from './loadGraph';
import { ExtensionToWebview, WebviewToExtension } from '../messages';

/**
 * Opens the graph view for the first workspace folder.
 * @param context The extension context, for file paths and cleanup.
 */
export async function openGraphPanel(context: vscode.ExtensionContext): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder === undefined) {
		vscode.window.showErrorMessage('Open a folder to see its graph.');
		return;
	}

	const distFolder = vscode.Uri.joinPath(context.extensionUri, 'dist');
	const panel = vscode.window.createWebviewPanel(
		'codeflowGraph',
		'Codeflow: ' + folder.name,
		vscode.ViewColumn.One,
		{ enableScripts: true, localResourceRoots: [distFolder] },
	);

	const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distFolder, 'webview.js'));
	panel.webview.html = buildHtml(scriptUri);

	// start scanning now, so it runs while the webview loads
	const graphPromise = loadGraph(folder);

	// the webview says "ready" each time its script starts, including after VS Code reloads a hidden panel
	async function handleMessage(message: WebviewToExtension): Promise<void> {
		if (message.type !== 'ready') {
			return;
		}

		try {
			const graph = await graphPromise;
			const reply: ExtensionToWebview = { type: 'graph', graph: graph };
			panel.webview.postMessage(reply);
		} catch (error) {
			vscode.window.showErrorMessage('Could not build the graph: ' + String(error));
		}
	}

	panel.webview.onDidReceiveMessage(handleMessage, undefined, context.subscriptions);
}

/**
 * Writes the webview page. Only tags carrying a random nonce may run, which blocks injected scripts.
 * @param scriptUri The webview-safe address of dist/webview.js.
 * @returns The page's HTML.
 */
function buildHtml(scriptUri: vscode.Uri): string {
	const nonce = randomBytes(16).toString('hex');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${nonce}">
		body {
			margin: 0;
			padding: 0;
			overflow: hidden;
			background: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}
		#world {
			position: relative;
		}
		#arrows {
			position: absolute;
			left: 0;
			top: 0;
			overflow: visible;
			pointer-events: none;
		}
		#arrows path {
			fill: none;
			stroke: var(--vscode-editorLineNumber-foreground);
			stroke-width: 1.5;
		}
		#arrows marker path {
			fill: var(--vscode-editorLineNumber-foreground);
			stroke: none;
		}
		.box {
			position: absolute;
			box-sizing: border-box;
			display: flex;
			align-items: center;
			padding: 0 10px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px;
			background: var(--vscode-editorWidget-background);
		}
		.box.folder {
			font-weight: 600;
		}
		.box.more {
			border-style: dashed;
			color: var(--vscode-descriptionForeground);
		}
		.label {
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
		}
	</style>
</head>
<body>
	<div id="world"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
