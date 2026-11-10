import { Graph, NodeKind } from './graph/types';

// sent by the webview once its script has loaded and can receive messages
export interface ReadyMessage {
	type: 'ready';
}

// sent by the webview to open a file in the editor, or show a folder in the Explorer
export interface OpenMessage {
	type: 'open';
	path: string; // repo-relative, like the node's path
	kind: NodeKind; // so the extension knows whether to open or reveal without checking the disk
}

// sent by the extension with the graph to draw
export interface GraphMessage {
	type: 'graph';
	graph: Graph;
}

export type WebviewToExtension = ReadyMessage | OpenMessage;
export type ExtensionToWebview = GraphMessage;
