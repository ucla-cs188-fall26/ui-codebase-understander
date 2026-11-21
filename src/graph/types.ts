export type NodeKind = 'repo' | 'directory' | 'file'; // add class/function later
export type EdgeKind = 'import' | 'flow'; // add call/reference later

export const ROOT_ID = '.';

export interface Node {
    id: string; // repo-relative path; the repo root is ROOT_ID
    kind: NodeKind;
    name: string;
    parent: string | null;
    path: string;
    childCount: number; // computed at build
}

// lines in a file, 1-based and inclusive: an import is one line, and a function later will span several
export interface LineRange {
    start: number;
    end: number;
}

export interface Edge {
    from: string; // node id
    to: string;
    kind: EdgeKind;
    lines?: LineRange; // where in the importing file it's written; missing on edges made by grouping
}

export interface Graph {
    nodes: Node[];
    edges: Edge[];
}
