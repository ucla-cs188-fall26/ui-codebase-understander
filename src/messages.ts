import { Graph, NodeKind } from './graph/types';
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

export type WebviewToExtension = ReadyMessage | OpenMessage | SaveLayoutMessage | RequestResetMessage | DiscoverModelsMessage | SelectModelMessage;
export type ExtensionToWebview = GraphMessage | ResetLayoutMessage | ModelsMessage;
