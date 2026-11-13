import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { loadGraph } from './loadGraph';
import { ExtensionToWebview, FlowScenario, ModelOption, WebviewToExtension } from '../messages';
import { SavedLayout } from '../layout/saved';
import { Graph } from '../graph/types';
import { CODE_EXTENSIONS } from '../graph/imports';

// where this workspace's layout is kept in VS Code's per-workspace storage
const LAYOUT_KEY = 'codeflow.layout';
const MODEL_KEY = 'codeflow.languageModel';
const BLOCKED_MODELS_KEY = 'codeflow.blockedLanguageModels';

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
	const activeWorkspaceFolder = workspaceFolder;

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
				const selectedModel = context.workspaceState.get<ModelOption>(MODEL_KEY);
				const reply: ExtensionToWebview = { type: 'graph', graph: graph, layout: layout, selectedModel: selectedModel };
				panel.webview.postMessage(reply);
			} catch (error) {
				vscode.window.showErrorMessage('Could not build the graph: ' + String(error));
			}
		}

		if (message.type === 'saveLayout') {
			await context.workspaceState.update(LAYOUT_KEY, message.layout);
		}

		if (message.type === 'discoverModels') {
			try {
				// This is deliberately initiated by the user's click: VS Code may ask for consent here.
				const models = await vscode.lm.selectChatModels();
				const blocked = new Set(context.globalState.get<string[]>(BLOCKED_MODELS_KEY, []));
				const options: ModelOption[] = models
					.filter((model) => !blocked.has(modelKey(model)) && context.languageModelAccessInformation.canSendRequest(model) !== false)
					.map((model) => ({
					id: model.id,
					vendor: model.vendor,
					name: model.name,
					family: model.family,
					}));
				const selected = context.workspaceState.get<ModelOption>(MODEL_KEY);
				panel.webview.postMessage({
					type: 'models',
					models: options,
					selected: selected,
					status: options.length === 0 ? 'No language models are available to this extension.' : undefined,
				});
			} catch (error) {
				const selected = context.workspaceState.get<ModelOption>(MODEL_KEY);
				panel.webview.postMessage({
					type: 'models',
					models: [],
					selected: selected,
					status: 'Could not load models: ' + String(error),
				});
			}
		}

		if (message.type === 'selectModel') {
			await context.workspaceState.update(MODEL_KEY, message.model);
		}

		if (message.type === 'generateFlows') {
			const selected = message.model;
			let currentModels: vscode.LanguageModelChat[] = [];
			try {
				if (selected === undefined) {
					panel.webview.postMessage({ type: 'flowResults', flows: [], status: 'Choose a language model first.' });
					return;
				}
				currentModels = await vscode.lm.selectChatModels({ id: selected.id, vendor: selected.vendor });
				const model = currentModels.find((candidate) => candidate.id === selected.id && candidate.vendor === selected.vendor);
				if (model === undefined) {
					panel.webview.postMessage({ type: 'flowResults', flows: [], status: 'The selected model is no longer available. Find models and choose another.' });
					return;
				}
				await context.workspaceState.update(MODEL_KEY, selected);

				const graph = await graphPromise;
				const prompt = await buildFlowPrompt(activeWorkspaceFolder, graph, model);
				const response = await model.sendRequest(
					[vscode.LanguageModelChatMessage.User(prompt)],
					{},
				);
				let responseText = '';
				for await (const part of response.stream) {
					if (part instanceof vscode.LanguageModelTextPart) {
						responseText += part.value;
					}
				}
				const flows = parseFlowScenarios(responseText, graph);
				panel.webview.postMessage({
					type: 'flowResults',
					flows: flows,
					status: flows.length === 0 ? 'The model returned no valid flows. Try generating again.' : 'Generated ' + flows.length + ' example flow' + (flows.length === 1 ? '.' : 's.'),
				});
			} catch (error) {
				if (selected !== undefined && String(error).toLowerCase().includes('only available to vs code core')) {
					const blocked = new Set(context.globalState.get<string[]>(BLOCKED_MODELS_KEY, []));
					blocked.add(modelKey(selected));
					await context.globalState.update(BLOCKED_MODELS_KEY, Array.from(blocked));
					await context.workspaceState.update(MODEL_KEY, undefined);
					const available = currentModels
						.filter((candidate) => !blocked.has(modelKey(candidate)) && context.languageModelAccessInformation.canSendRequest(candidate) !== false)
						.map((candidate) => ({ id: candidate.id, vendor: candidate.vendor, name: candidate.name, family: candidate.family }));
					panel.webview.postMessage({
						type: 'models',
						models: available,
						selected: undefined,
						status: selected.name + ' is only available to VS Code itself. Choose another model.',
					});
					return;
				}
				panel.webview.postMessage({ type: 'flowResults', flows: [], status: 'Flow generation failed: ' + String(error) });
			}
		}

		if (message.type === 'requestReset') {
			await resetLayout();
		}

		if (message.type === 'openFlow') {
			try {
				const graph = await graphPromise;
				await openFlowPanel(context, activeWorkspaceFolder, graph, message.flow);
			} catch (error) {
				vscode.window.showErrorMessage('Could not open the flow: ' + String(error));
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

	// remember this panel for commands, and forget it once it closes
	currentPanel = panel;
	function handleDispose(): void {
		if (currentPanel === panel) {
			currentPanel = undefined;
		}
	}
	panel.onDidDispose(handleDispose, undefined, context.subscriptions);
}

async function openFlowPanel(context: vscode.ExtensionContext, workspaceFolder: vscode.WorkspaceFolder, graph: Graph, flow: FlowScenario): Promise<void> {
	const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
	const seen = new Set<string>();
	const steps = flow.steps.filter((step) => {
		const node = nodesById.get(step.nodeId);
		if (node === undefined || node.kind !== 'file' || seen.has(step.nodeId)) {
			return false;
		}
		seen.add(step.nodeId);
		return true;
	});
	if (steps.length < 2 || steps[0].nodeId !== flow.entryNodeId) {
		vscode.window.showErrorMessage('This flow no longer matches the repository graph. Generate flows again.');
		return;
	}
	const flowNodes = steps.map((step) => nodesById.get(step.nodeId)!);
	const flowEdges = steps.slice(1).map((step, index) => ({ from: steps[index].nodeId, to: step.nodeId, kind: 'flow' as const }));
	const flowGraph: Graph = { nodes: flowNodes, edges: flowEdges };
	const safeFlow: FlowScenario = { ...flow, steps: steps, entryNodeId: steps[0].nodeId };
	const distDirectory = vscode.Uri.joinPath(context.extensionUri, 'dist');
	const panel = vscode.window.createWebviewPanel(
		'codeflowFlow',
		'Flow: ' + flow.title,
		vscode.ViewColumn.Beside,
		{ enableScripts: true, localResourceRoots: [distDirectory] },
	);
	const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distDirectory, 'webview.js'));
	panel.webview.html = buildHtml(scriptUri);
	const workspaceUri = workspaceFolder.uri;
	const allowedPaths = new Set(flowNodes.map((node) => node.path));
	panel.webview.onDidReceiveMessage(async (message: WebviewToExtension) => {
		if (message.type === 'ready') {
			const reply: ExtensionToWebview = { type: 'flowGraph', graph: flowGraph, flow: safeFlow };
			panel.webview.postMessage(reply);
		}
		if (message.type === 'open' && message.kind === 'file' && allowedPaths.has(message.path)) {
			const uri = vscode.Uri.joinPath(workspaceUri, message.path);
			await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside });
		}
	}, undefined, context.subscriptions);
}

function modelKey(model: Pick<ModelOption, 'vendor' | 'id'>): string {
	return model.vendor + '\u0000' + model.id;
}

/** Builds a bounded, repository-grounded prompt from graph metadata and source files. */
async function buildFlowPrompt(workspaceFolder: vscode.WorkspaceFolder, graph: Graph, model: vscode.LanguageModelChat): Promise<string> {
	let nodes = graph.nodes.slice(0, 500).map((node) => ({ id: node.id, kind: node.kind, path: node.path }));
	let edges = graph.edges.slice(0, 700).map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind }));
	const sourceBudget = Math.min(20000, Math.max(4000, Math.floor(model.maxInputTokens * 0.55)));
	const candidates = graph.nodes
		.filter((node) => node.kind === 'file' && CODE_EXTENSIONS.some((extension) => node.path.endsWith(extension)))
		.sort((a, b) => sourcePriority(b.path) - sourcePriority(a.path) || a.path.localeCompare(b.path));
	const decoder = new TextDecoder();
	const source: string[] = [];
	let used = 0;
	for (const node of candidates) {
		if (used >= sourceBudget) {
			break;
		}
		try {
			const uri = vscode.Uri.joinPath(workspaceFolder.uri, node.path);
			const bytes = await vscode.workspace.fs.readFile(uri);
			const remaining = sourceBudget - used;
			const content = decoder.decode(bytes).slice(0, Math.min(2400, remaining));
			if (content.length === 0) {
				continue;
			}
			source.push('FILE ' + node.path + '\n' + content);
			used += content.length;
		} catch {
			// A file may have changed or disappeared since the graph was scanned; omit it from context.
		}
	}

function makePrompt(): string {
		return `Analyze this repository and identify up to 8 concrete user-facing or system flows (for example, sign in, create a record, submit a form, or load a page). Use the source excerpts and import graph as evidence. A flow is an ordered path through files, not a claim that import arrows prove runtime call order. Prefer distinct, meaningful scenarios; do not invent features unsupported by the repository.

Return only valid JSON with this shape:
{"flows":[{"title":"Short scenario name","summary":"One sentence","entryNodeId":"repo-relative file path","steps":[{"nodeId":"repo-relative file path","action":"What this file does in this step"}]}]}
Every nodeId and entryNodeId must exactly match an ID in the graph. Include 2 to 8 steps per flow, in likely execution order. Keep titles and step actions concise. If evidence is insufficient, return {"flows":[]}.

REPOSITORY GRAPH NODES (IDs are repository-relative paths):
${JSON.stringify(nodes)}

IMPORT EDGES (from imports to imported file):
${JSON.stringify(edges)}

SOURCE EXCERPTS:
${source.join('\n\n')}`;
}

	let prompt = makePrompt();
	const targetTokens = Math.max(512, Math.floor(model.maxInputTokens * 0.82));
	for (let attempt = 0; attempt < 8; attempt++) {
		if (await model.countTokens(prompt) <= targetTokens) {
			return prompt;
		}
		if (source.length > 2) {
			source.splice(Math.ceil(source.length * 0.75));
		} else if (edges.length > 80) {
			edges = edges.slice(0, Math.floor(edges.length * 0.65));
		} else if (nodes.length > 80) {
			nodes = nodes.slice(0, Math.floor(nodes.length * 0.65));
		} else {
			break;
		}
		prompt = makePrompt();
	}
	return prompt;
}

function sourcePriority(path: string): number {
	const lower = path.toLowerCase();
	let score = 0;
	for (const word of ['route', 'page', 'auth', 'login', 'controller', 'handler', 'service', 'api', 'view', 'command']) {
		if (lower.includes(word)) {
			score += 2;
		}
	}
	if (lower.startsWith('src/')) {
		score += 1;
	}
	return score;
}

function parseFlowScenarios(responseText: string, graph: Graph): FlowScenario[] {
	const jsonText = responseText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	const start = jsonText.indexOf('{');
	const end = jsonText.lastIndexOf('}');
	if (start < 0 || end <= start) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText.slice(start, end + 1));
	} catch {
		return [];
	}
	if (typeof parsed !== 'object' || parsed === null || !('flows' in parsed) || !Array.isArray(parsed.flows)) {
		return [];
	}
	const fileIds = new Set(graph.nodes.filter((node) => node.kind === 'file').map((node) => node.id));
	const valid: FlowScenario[] = [];
	for (const item of parsed.flows) {
		if (typeof item !== 'object' || item === null) {
			continue;
		}
		const candidate = item as { title?: unknown; summary?: unknown; entryNodeId?: unknown; steps?: unknown };
		if (typeof candidate.title !== 'string' || typeof candidate.summary !== 'string'
			|| typeof candidate.entryNodeId !== 'string' || !Array.isArray(candidate.steps)) {
			continue;
		}
		const steps = candidate.steps.filter((step): step is { nodeId: string; action: string } => {
			if (typeof step !== 'object' || step === null) {
				return false;
			}
			const row = step as { nodeId?: unknown; action?: unknown };
			return typeof row.nodeId === 'string' && fileIds.has(row.nodeId) && typeof row.action === 'string';
		}).slice(0, 8);
		if (!fileIds.has(candidate.entryNodeId) || steps.length < 2 || steps[0].nodeId !== candidate.entryNodeId) {
			continue;
		}
		valid.push({
			title: candidate.title.slice(0, 120),
			summary: candidate.summary.slice(0, 400),
			entryNodeId: candidate.entryNodeId,
			steps: steps,
		});
		if (valid.length >= 8) {
			break;
		}
	}
	return valid;
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
			stroke-width: 2.5;
			pointer-events: stroke;
			cursor: pointer;
		}
		.arrow.selected path {
			stroke: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
			stroke-width: 3;
			filter: drop-shadow(0 0 4px var(--vscode-focusBorder, var(--vscode-textLink-foreground)));
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
			cursor: pointer;
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
		.strip:hover {
			color: var(--vscode-editor-foreground);
			background: var(--vscode-toolbar-hoverBackground);
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
		.text-button:disabled {
			cursor: wait;
			opacity: 0.7;
		}
		#model-select {
			max-width: 230px;
			padding: 3px 6px;
			border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
			border-radius: 4px;
			background: var(--vscode-dropdown-background);
			color: var(--vscode-dropdown-foreground);
			font: inherit;
		}
		#model-select:disabled {
			opacity: 0.75;
		}
		#model-status {
			align-self: center;
			max-width: 220px;
			padding: 0 4px;
			overflow: hidden;
			color: var(--vscode-descriptionForeground);
			font-size: 11px;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#flow-results {
			display: none;
			position: fixed;
			top: 58px;
			left: 12px;
			width: min(380px, calc(100% - 24px));
			max-height: calc(100% - 70px);
			z-index: 1000;
			box-sizing: border-box;
			padding: 12px 14px;
			overflow-y: auto;
			cursor: default;
			border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
			border-radius: 8px;
			background: var(--vscode-editorWidget-background);
			color: var(--vscode-editorWidget-foreground);
			box-shadow: 0 4px 16px var(--vscode-widget-shadow);
		}
		#flow-results.visible {
			display: block;
		}
		#flow-description {
			display: none;
			position: fixed;
		top: 58px;
			left: 12px;
			max-width: min(560px, calc(100% - 24px));
			z-index: 1000;
			box-sizing: border-box;
			padding: 10px 14px;
			border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
			border-radius: 8px;
			background: var(--vscode-editorWidget-background);
			color: var(--vscode-editorWidget-foreground);
			box-shadow: 0 4px 16px var(--vscode-widget-shadow);
		}
		#flow-description.visible {
			display: grid;
			gap: 4px;
		}
		#flow-description small,
		.flow-node-path,
		.flow-step-action {
			color: var(--vscode-descriptionForeground);
		}
		.flow-view-title {
			max-width: min(480px, 50vw);
			padding: 0 8px;
		overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.flow-node .box-title {
			flex: 0 0 34px;
			box-sizing: border-box;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.flow-node-path {
			padding: 5px 10px 0;
			overflow: hidden;
			font-size: 11px;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.flow-step-action {
			padding: 5px 10px;
			font-size: 12px;
			line-height: 1.3;
		}
		.flow-title-button {
			padding: 0;
			border: 0;
			background: none;
			color: inherit;
			font: inherit;
			font-weight: 600;
			text-align: left;
			cursor: pointer;
		}
		.flow-title-button:hover {
			color: var(--vscode-textLink-foreground);
			text-decoration: underline;
		}
		.flow-results-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 8px;
		}
		.flow-status {
			margin-bottom: 8px;
			color: var(--vscode-descriptionForeground);
		}
		.flow-card {
			padding: 10px 0;
			border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
		}
		.flow-card p {
			margin: 4px 0 8px;
			color: var(--vscode-descriptionForeground);
		}
		.flow-card ol {
			margin: 0;
			padding-left: 22px;
		}
		.flow-card li {
			margin: 5px 0;
		}
		.flow-path-button {
			padding: 0;
			border: 0;
			background: none;
			color: var(--vscode-textLink-foreground);
			font: inherit;
			text-align: left;
			cursor: pointer;
			word-break: break-word;
		}
		.flow-path-button:hover {
			text-decoration: underline;
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
	<aside id="flow-results" aria-live="polite"></aside>
	<aside id="flow-description"></aside>
	<div id="toolbar"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
