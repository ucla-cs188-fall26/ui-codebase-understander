export type NodeKind = 'repo' | 'folder' | 'file'; // add class/function later
export type EdgeKind = 'import'; // add call/reference later

export const ROOT_ID = '.';

export interface Node {
	id: string; // repo-relative path; the repo root is ROOT_ID
	kind: NodeKind;
	name: string;
	parent: string | null;
	path: string;
	childCount: number; // computed at build
}

export interface Edge {
	from: string; // node id
	to: string;
	kind: EdgeKind;
}

export interface Graph {
	nodes: Node[];
	edges: Edge[];
}
