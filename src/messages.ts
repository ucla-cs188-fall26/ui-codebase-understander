import { Graph, LineRange, NodeKind } from './graph/types';
import { SavedLayout } from './layout/saved';

// sent by the webview once its script has loaded and can receive messages
export interface ReadyMessage {
	type: 'ready';
}

// sent by the webview to open a file in the editor, or show a directory in the Explorer
export interface OpenMessage {
	type: 'open';
	path: string; // repo-relative, like the node's path
	kind: NodeKind; // so the extension knows whether to open or reveal without checking the disk
	lines?: LineRange; // for a file, the lines to select and bring into view
}

// sent by the webview after the layout or camera changes, to be stored for next time
export interface SaveLayoutMessage {
	type: 'saveLayout';
	layout: SavedLayout;
}

// sent by the extension with the graph to draw
export interface GraphMessage {
	type: 'graph';
	graph: Graph;
	layout: SavedLayout | undefined; // undefined until something has been saved for this workspace
	selectedModel: ModelOption | undefined;
}

// sent by the extension when the user runs Reset Layout, to put the whole graph back to the default
export interface ResetLayoutMessage {
	type: 'resetLayout';
}

// sent by the webview's toolbar; the extension asks to confirm, since only it can show VS Code's dialogs
export interface RequestResetMessage {
	type: 'requestReset';
}

export interface ModelOption {
	id: string;
	vendor: string;
	name: string;
	family: string;
}

/**
 * Names a language model uniquely, since two vendors can use the same id.
 * @param model The model.
 * @returns Its vendor and id, joined.
 */
export function modelKey(model: Pick<ModelOption, 'vendor' | 'id'>): string {
	return model.vendor + '\u0000' + model.id;
}

export interface DiscoverModelsMessage {
	type: 'discoverModels';
}

export interface SelectModelMessage {
	type: 'selectModel';
	model: ModelOption | undefined;
}

export interface ModelsMessage {
	type: 'models';
	models: ModelOption[];
	selected: ModelOption | undefined;
	status?: string;
}

export interface GenerateFlowsMessage {
	type: 'generateFlows';
	model: ModelOption | undefined;
}

export interface FlowStep {
	nodeId: string;
	action: string;
}

export interface FlowScenario {
	title: string;
	summary: string;
	entryNodeId: string;
	steps: FlowStep[];
}

export interface FlowResultsMessage {
	type: 'flowResults';
	flows: FlowScenario[];
	status?: string;
}

export interface OpenFlowMessage {
	type: 'openFlow';
	flow: FlowScenario;
}

export interface FlowGraphMessage {
	type: 'flowGraph';
	graph: Graph;
	flow: FlowScenario;
}

// the user's color settings; an empty one means follow the theme
export interface StyleColors {
	folder: string;
	file: string;
	arrow: string;
	highlight: string;
}

// sent when the graph opens and whenever a codeflow.* setting changes
export interface StyleMessage {
	type: 'style';
	colors: StyleColors;
}

export type WebviewToExtension = ReadyMessage | OpenMessage | OpenFlowMessage | SaveLayoutMessage | RequestResetMessage | DiscoverModelsMessage | SelectModelMessage | GenerateFlowsMessage;
export type ExtensionToWebview = GraphMessage | FlowGraphMessage | ResetLayoutMessage | ModelsMessage | FlowResultsMessage | StyleMessage;
