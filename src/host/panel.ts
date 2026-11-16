import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { loadGraph } from './loadGraph';
import { ExtensionToWebview, FlowScenario, ModelOption, modelKey, StyleColors, WebviewToExtension } from '../messages';
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

	const panel = createPanel(context, 'codeflowGraph', 'Codeflow: ' + workspaceFolder.name, vscode.ViewColumn.One);

	// start scanning now, so it runs while the webview loads
	const graphPromise = loadGraph(workspaceFolder);

	async function handleMessage(message: WebviewToExtension): Promise<void> {
		// the webview says "ready" each time its script starts, including after VS Code reloads a hidden panel
		if (message.type === 'ready') {
			// colors first, so the graph draws in them from the start
			const style: ExtensionToWebview = { type: 'style', colors: readStyleColors() };
			panel.webview.postMessage(style);
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
				const options = usableModels(context, await vscode.lm.selectChatModels());
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
					const available = usableModels(context, currentModels);
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
				// the lines asked for, if any: selected from the start of the first to the end of the last, so they're
				// highlighted
				let selection: vscode.Range | undefined = undefined;
				if (message.lines !== undefined) {
					selection = new vscode.Range(message.lines.start - 1, 0, message.lines.end, 0);
				}
				// in a group the graph isn't in, so the graph stays in view: one that's already open if there is one,
				// so each file opens as a tab there instead of splitting the window again; otherwise a new one beside
				const editor = await vscode.window.showTextDocument(uri, { viewColumn: otherColumn(panel), selection: selection });
				if (message.lines !== undefined && selection !== undefined) {
					// a short range centers; a long one, like a big function later, starts at the top so its beginning
					// shows
					const short = message.lines.end - message.lines.start < 20;
					const reveal = short ? vscode.TextEditorRevealType.InCenter : vscode.TextEditorRevealType.AtTop;
					editor.revealRange(selection, reveal);
				}
			} else {
				await vscode.commands.executeCommand('revealInExplorer', uri);
			}
		}
	}

	panel.webview.onDidReceiveMessage(handleMessage, undefined, context.subscriptions);

	// a changed codeflow.* setting reaches the open graph right away
	function handleSettingsChange(event: vscode.ConfigurationChangeEvent): void {
		if (event.affectsConfiguration('codeflow')) {
			const style: ExtensionToWebview = { type: 'style', colors: readStyleColors() };
			panel.webview.postMessage(style);
		}
	}
	const settingsListener = vscode.workspace.onDidChangeConfiguration(handleSettingsChange);

	// remember this panel for commands, and forget it once it closes, along with its settings listener
	currentPanel = panel;
	function handleDispose(): void {
		if (currentPanel === panel) {
			currentPanel = undefined;
		}
		settingsListener.dispose();
	}
	panel.onDidDispose(handleDispose, undefined, context.subscriptions);
}

/**
 * Opens a panel running the webview's script.
 * @param context The extension context, for file paths.
 * @param viewType VS Code's id for the kind of panel.
 * @param title The panel's tab title.
 * @param column Where it opens.
 * @returns The panel.
 */
function createPanel(context: vscode.ExtensionContext, viewType: string, title: string, column: vscode.ViewColumn): vscode.WebviewPanel {
	const distDirectory = vscode.Uri.joinPath(context.extensionUri, 'dist');
	const panel = vscode.window.createWebviewPanel(viewType, title, column, { enableScripts: true, localResourceRoots: [distDirectory] });
	panel.webview.html = buildHtml(panel.webview, distDirectory);
	return panel;
}

/**
 * Reads the user's color settings.
 * @returns Each codeflow.* color; an empty one means follow the theme.
 */
function readStyleColors(): StyleColors {
	const settings = vscode.workspace.getConfiguration('codeflow');
	return {
		folder: settings.get<string>('folderColor', ''),
		file: settings.get<string>('fileColor', ''),
		arrow: settings.get<string>('arrowColor', ''),
		highlight: settings.get<string>('highlightColor', ''),
	};
}

/**
 * Opens a flow in its own panel: its files in order, one row of boxes, each clickable to open the file. Steps whose files
 * no longer exist, aren't files, or repeat are dropped.
 * @param context The extension context.
 * @param workspaceFolder The folder the graph is of.
 * @param graph The graph.
 * @param flow The flow.
 */
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
	const panel = createPanel(context, 'codeflowFlow', 'Flow: ' + flow.title, vscode.ViewColumn.Beside);
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

/**
 * Picks where to open a file so the graph stays in view: the open group next to the graph's (to its right if there
 * is one, else to its left), or a new group beside the graph if it's the only one.
 * @param panel The graph's panel.
 * @returns The column to open in.
 */
function otherColumn(panel: vscode.WebviewPanel): vscode.ViewColumn {
	const graphColumn = panel.viewColumn ?? vscode.ViewColumn.One;
	let right: vscode.ViewColumn | undefined = undefined;
	let left: vscode.ViewColumn | undefined = undefined;
	for (const group of vscode.window.tabGroups.all) {
		if (group.viewColumn > graphColumn && (right === undefined || group.viewColumn < right)) {
			right = group.viewColumn;
		}
		if (group.viewColumn < graphColumn && (left === undefined || group.viewColumn > left)) {
			left = group.viewColumn;
		}
	}
	return right ?? left ?? vscode.ViewColumn.Beside;
}

/**
 * Lists the language models this extension may use: not ones it's found VS Code keeps to itself, and not ones the user
 * hasn't allowed.
 * @param context The extension context, which remembers blocked models and knows what's allowed.
 * @param models The models VS Code offered.
 * @returns Them, as the webview shows them.
 */
function usableModels(context: vscode.ExtensionContext, models: vscode.LanguageModelChat[]): ModelOption[] {
	const blocked = new Set(context.globalState.get<string[]>(BLOCKED_MODELS_KEY, []));
	const usable: ModelOption[] = [];
	for (const model of models) {
		if (!blocked.has(modelKey(model)) && context.languageModelAccessInformation.canSendRequest(model) !== false) {
			usable.push({ id: model.id, vendor: model.vendor, name: model.name, family: model.family });
		}
	}
	return usable;
}

/**
 * Builds the prompt asking a model for flows: the graph's nodes and edges and excerpts of the source, most likely
 * entry points first, trimmed until it fits the model's input.
 * @param workspaceFolder The folder the graph is of.
 * @param graph The graph.
 * @param model The model, for its input limit.
 * @returns The prompt.
 */
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

/**
 * Scores how likely a file is to be part of a flow, from words in its path, so the prompt's source excerpts start there.
 * @param path The file's path.
 * @returns Higher for likelier files.
 */
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

/**
 * Reads the flows out of a model's reply, keeping only well-formed ones whose steps are files in the graph, starting at
 * the entry point.
 * @param responseText The model's reply, JSON perhaps wrapped in a code fence.
 * @param graph The graph.
 * @returns Up to 8 flows, each with up to 8 steps.
 */
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
 * Writes the webview page. Only scripts carrying a random nonce may run, which blocks injected scripts, and only
 * stylesheets from the extension's own files load.
 * @param webview The panel's webview, for the addresses its files are served from.
 * @param distDirectory The extension's dist folder, which holds webview.js and webview.css.
 * @returns The page's HTML.
 */
function buildHtml(webview: vscode.Webview, distDirectory: vscode.Uri): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distDirectory, 'webview.js'));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distDirectory, 'webview.css'));
	const nonce = randomBytes(16).toString('hex');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div id="world"></div>
	<aside id="sidebar"></aside>
	<aside id="flow-results" aria-live="polite"></aside>
	<aside id="flow-description"></aside>
	<div id="toolbar"></div>
	<div id="page-menu"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
