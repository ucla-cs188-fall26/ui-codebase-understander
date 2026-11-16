import { buildTree } from '../graph/build';
import { Edge } from '../graph/types';
import { buildGraphInfo, GraphInfo } from '../layout/state';

// a short way to write an edge in the layout tests
export function edge(from: string, to: string): Edge {
	return { from: from, to: to, kind: 'import' };
}

// a small graph for the view tests: root → src → { a.ts, lib → { b.ts, c.ts } }, with a.ts importing b.ts
export function makeInfo(): GraphInfo {
	const nodes = buildTree('repo', ['src/a.ts', 'src/lib/b.ts', 'src/lib/c.ts']);
	return buildGraphInfo({ nodes: nodes, edges: [edge('src/a.ts', 'src/lib/b.ts')] });
}
