import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { loadGraph } from './loadGraph';
import { ExtensionToWebview, WebviewToExtension } from '../messages';
import { SavedLayout } from '../layout/saved';

// where this workspace's layout is kept in VS Code's per-workspace storage
const LAYOUT_KEY = 'codeflow.layout';

// the graph panel that's open, so commands like Reset Layout can reach it; undefined when it's closed
let currentPanel: vscode.WebviewPanel | undefined = undefined;

/**
 * Puts the whole graph back to the default layout, after asking, since it throws away every arrangement.
 */
export async function resetLayout(): Promise<void> {
	if (currentPanel === undefined) {
		return;
	}

	const answer = await vscode.window.showWarningMessage(
		'Reset the whole layout? Every node closes and goes back to where it started.',
		{ modal: true },
		'Reset',
	);
	if (answer !== 'Reset') {
		return;
	}

	const message: ExtensionToWebview = { type: 'resetLayout' };
	currentPanel.webview.postMessage(message);
}

/**
 * Opens the graph view for the first workspace folder.
 * @param context The extension context, for file paths and cleanup.
 */
export async function openGraphPanel(context: vscode.ExtensionContext): Promise<void> {
	// "folder" here is VS Code's word for what's open in the window (File > Open Folder)
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (workspaceFolder === undefined) {
		vscode.window.showErrorMessage('Open a folder to see its graph.');
		return;
	}

	// saved here, past the check above, so functions inside can use it without re-checking for undefined
	const workspaceUri = workspaceFolder.uri;

	const distDirectory = vscode.Uri.joinPath(context.extensionUri, 'dist');
	const panel = vscode.window.createWebviewPanel(
		'codeflowGraph',
		'Codeflow: ' + workspaceFolder.name,
		vscode.ViewColumn.One,
		{ enableScripts: true, localResourceRoots: [distDirectory] },
	);

	const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distDirectory, 'webview.js'));
	panel.webview.html = buildHtml(scriptUri);

	// start scanning now, so it runs while the webview loads
	const graphPromise = loadGraph(workspaceFolder);

	async function handleMessage(message: WebviewToExtension): Promise<void> {
		// the webview says "ready" each time its script starts, including after VS Code reloads a hidden panel
		if (message.type === 'ready') {
			try {
				const graph = await graphPromise;
				const layout = context.workspaceState.get<SavedLayout>(LAYOUT_KEY);
				const reply: ExtensionToWebview = { type: 'graph', graph: graph, layout: layout };
				panel.webview.postMessage(reply);
			} catch (error) {
				vscode.window.showErrorMessage('Could not build the graph: ' + String(error));
			}
		}

		if (message.type === 'saveLayout') {
			await context.workspaceState.update(LAYOUT_KEY, message.layout);
		}

		if (message.type === 'requestReset') {
			await resetLayout();
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

	// remember this panel for commands, and forget it once it closes
	currentPanel = panel;
	function handleDispose(): void {
		if (currentPanel === panel) {
			currentPanel = undefined;
		}
	}
	panel.onDidDispose(handleDispose, undefined, context.subscriptions);
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
		/* while a box is being dragged, keep the move cursor everywhere, even off the box */
		body.dragging,
		body.dragging * {
			cursor: move;
		}
		/* the same while resizing, with the diagonal resize cursor */
		body.resizing,
		body.resizing * {
			cursor: nwse-resize;
		}
		/* the selected box's lower-right corner, for resizing it */
		.resize-handle {
			position: absolute;
			right: 0;
			bottom: 0;
			display: flex;
			color: var(--vscode-descriptionForeground);
			cursor: nwse-resize;
		}
		.resize-handle svg {
			fill: none;
			stroke: currentColor;
			stroke-width: 1.5;
		}
		#world {
			position: relative;
			transform-origin: 0 0;
			/* dragging boxes and panning shouldn't select their text; the sidebar is outside, so paths there still copy */
			user-select: none;
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
		/* a column: the title on top, and for an open box, room for its children below */
		.box {
			position: absolute;
			box-sizing: border-box;
			display: flex;
			flex-direction: column;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px;
			background: var(--vscode-editorWidget-background);
		}
		.box-title {
			display: flex;
			flex-shrink: 0;
			align-items: center;
			min-width: 0;
			padding: 0 10px;
		}
		/* only the selected box can be moved, by its title (all of a closed box); everything else pans */
		.box.selected > .box-title {
			cursor: move;
		}
		/* muted dots at the right end of the selected box's title, a sign that it can be dragged */
		.grip {
			display: flex;
			flex-shrink: 0;
			margin-left: auto;
			padding-left: 6px;
			visibility: hidden;
			color: var(--vscode-descriptionForeground);
		}
		.box.selected > .box-title .grip {
			visibility: visible;
		}
		.grip svg {
			fill: none;
			stroke: currentColor;
			stroke-width: 2;
			stroke-linecap: round;
		}
		/* a closed box is all title */
		.box:not(.open) .box-title {
			flex: 1;
		}
		/* an open box's title is a header strip as tall as the space the layout leaves for it (HEADER in state.ts),
		   in the card color, sitting on the darker inside */
		.box.open .box-title {
			height: 32px;
			box-sizing: border-box;
			border-bottom: 1px solid var(--vscode-panel-border);
			border-radius: 7px 7px 0 0;
			background: var(--vscode-editorWidget-background);
		}
		.box.directory {
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
			background: var(--vscode-editor-background);
		}
		/* a "+N" bar in a box's padding, standing in for the children hidden on that side */
		.strip {
			position: absolute;
			box-sizing: border-box;
			display: flex;
			align-items: center;
			justify-content: center;
			overflow: hidden;
			border-radius: 4px;
			border: 2px dotted var(--vscode-descriptionForeground);
			color: var(--vscode-descriptionForeground);
			font-size: 11px;
			white-space: nowrap;
		}
		/* a right strip is tall and thin, so its count reads top to bottom */
		.strip-right {
			writing-mode: vertical-rl;
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
		/* the same floating-card look as the sidebar, so both read as part of the graph view */
		#toolbar {
			position: fixed;
			top: 12px;
			left: 12px;
			z-index: 1000;
			display: flex;
			gap: 2px;
			padding: 4px;
			cursor: default;
			border-radius: 8px;
			background: var(--vscode-editorWidget-background);
			color: var(--vscode-editorWidget-foreground);
			border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
			box-shadow: 0 4px 16px var(--vscode-widget-shadow);
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
		.sidebar-actions {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin: 10px 0 14px;
		}
		/* toolbar grays and a widget border, which every theme shows; some themes leave secondary button colors transparent */
		.text-button {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
			border-radius: 4px;
			background: var(--vscode-toolbar-hoverBackground);
			color: inherit;
			font: inherit;
			line-height: 1;
			cursor: pointer;
		}
		.text-button:hover {
			background: var(--vscode-toolbar-activeBackground);
		}
		.text-button svg {
			display: block;
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
		.sidebar-label {
			flex-shrink: 0;
			width: 110px;
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
		/* small open arrows, in list rows and next to Path: one per row would be cluttered, so each only shows on
		   the row under the mouse; small, since even hidden it sets how tall its row is */
		.sidebar-link .icon-button,
		.sidebar-row .icon-button {
			visibility: hidden;
			width: 18px;
			height: 18px;
		}
		.sidebar-link .icon-button svg,
		.sidebar-row .icon-button svg {
			width: 14px;
			height: 14px;
		}
		.sidebar-link:hover .icon-button,
		.sidebar-row:hover .icon-button {
			visibility: visible;
		}
		/* a detail row with an arrow centers it on the text; other rows stay top-aligned so wrapped labels read well */
		.sidebar-row:has(.icon-button) {
			align-items: center;
		}
		.sidebar-directory {
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
	<div id="toolbar"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
