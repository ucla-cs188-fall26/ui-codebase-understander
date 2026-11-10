import { Graph } from './graph/types';

// sent by the webview once its script has loaded and can receive messages
export interface ReadyMessage {
	type: 'ready';
}

// sent by the extension with the graph to draw
export interface GraphMessage {
	type: 'graph';
	graph: Graph;
}

export type WebviewToExtension = ReadyMessage;
export type ExtensionToWebview = GraphMessage;
