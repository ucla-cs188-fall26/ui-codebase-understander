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

	// saved here, past the check above, so functions inside can use it without re-checking for undefined
	const workspaceUri = folder.uri;

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

	async function handleMessage(message: WebviewToExtension): Promise<void> {
		// the webview says "ready" each time its script starts, including after VS Code reloads a hidden panel
		if (message.type === 'ready') {
			try {
				const graph = await graphPromise;
				const reply: ExtensionToWebview = { type: 'graph', graph: graph };
				panel.webview.postMessage(reply);
			} catch (error) {
				vscode.window.showErrorMessage('Could not build the graph: ' + String(error));
			}
		}

		if (message.type === 'open') {
			const uri = vscode.Uri.joinPath(workspaceUri, message.path);
			if (message.kind === 'file') {
				// beside the graph, so the graph stays in view
				await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside });
			} else {
				await vscode.commands.executeCommand('revealInExplorer', uri);
			}
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
		html {
			height: 100%;
		}
		body {
			height: 100%;
			cursor: grab;
			margin: 0;
			padding: 0;
			overflow: hidden;
			background: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}
		body.panning {
			cursor: grabbing;
		}
		#world {
			position: relative;
			transform-origin: 0 0;
		}
		#world.gliding {
			transition: transform 300ms ease-out;
		}
		.arrow {
			position: absolute;
			left: 0;
			top: 0;
			overflow: visible;
			pointer-events: none;
		}
		.arrow path {
			fill: none;
			stroke: var(--vscode-editorLineNumber-foreground);
			stroke-width: 1.5;
		}
		#arrowheads {
			position: absolute;
			width: 0;
			height: 0;
		}
		#arrowheads path {
			fill: var(--vscode-editorLineNumber-foreground);
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
		.box.selected {
			border-color: var(--vscode-focusBorder);
		}
		.chevron {
			display: inline-flex;
			flex-shrink: 0;
			align-items: center;
			justify-content: center;
			width: 20px;
			height: 20px;
			margin: 0 4px 0 -4px;
			border-radius: 4px;
			font-size: 14px;
			cursor: pointer;
		}
		.chevron:hover {
			background: var(--vscode-toolbar-hoverBackground);
		}
		.box.open {
			align-items: flex-start;
			padding-top: 8px;
			background: var(--vscode-editor-background);
		}
		.box.more {
			border-style: dashed;
			color: var(--vscode-descriptionForeground);
		}
		#sidebar {
			display: none;
			position: fixed;
			top: 12px;
			right: 12px;
			width: 280px;
			max-height: calc(100% - 24px);
			z-index: 1000;
			box-sizing: border-box;
			padding: 12px 16px;
			overflow-y: auto;
			cursor: default;
			border-radius: 8px;
			background: var(--vscode-editorWidget-background);
			color: var(--vscode-editorWidget-foreground);
			border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
			box-shadow: 0 4px 16px var(--vscode-widget-shadow);
		}
		#sidebar.visible {
			display: block;
		}
		.sidebar-header {
			display: flex;
			align-items: center;
			gap: 8px;
			font-weight: 600;
		}
		.icon-button {
			display: flex;
			flex-shrink: 0;
			align-items: center;
			justify-content: center;
			width: 24px;
			height: 24px;
			padding: 0;
			border: none;
			border-radius: 4px;
			background: none;
			color: inherit;
			cursor: pointer;
		}
		.icon-button:hover {
			background: var(--vscode-toolbar-hoverBackground);
		}
		.icon-button svg {
			fill: none;
			stroke: currentColor;
			stroke-width: 1.5;
		}
		.sidebar-close {
			margin-left: auto;
		}
		.sidebar-row {
			display: flex;
			gap: 8px;
			margin-top: 6px;
		}
		/* a row with a button centers it on the text; other rows stay top-aligned so wrapped labels read well */
		.sidebar-row:has(.icon-button) {
			align-items: center;
		}
		.sidebar-label {
			flex-shrink: 0;
			width: 96px;
			color: var(--vscode-descriptionForeground);
		}
		.sidebar-value {
			overflow-wrap: anywhere;
		}
		.sidebar-link {
			display: flex;
			align-items: center;
			gap: 4px;
			cursor: pointer;
		}
		.sidebar-link-text {
			flex: 1;
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
		}
		.sidebar-link:hover .sidebar-link-text {
			color: var(--vscode-textLink-foreground);
			text-decoration: underline;
		}
		/* one open button per row would be cluttered, so it only shows on the row under the mouse;
		   it is also smaller here, since even hidden it sets how tall each row is */
		.sidebar-link .icon-button {
			visibility: hidden;
			width: 18px;
			height: 18px;
		}
		.sidebar-link .icon-button svg {
			width: 14px;
			height: 14px;
		}
		.sidebar-link:hover .icon-button {
			visibility: visible;
		}
		.sidebar-folder {
			font-weight: 600;
		}
		.sidebar-indented {
			padding-left: 16px;
		}
		.sidebar-empty {
			color: var(--vscode-descriptionForeground);
		}
		.sidebar-section {
			margin: 16px 0 4px;
			font-size: 11px;
			text-transform: uppercase;
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
	<aside id="sidebar"></aside>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
