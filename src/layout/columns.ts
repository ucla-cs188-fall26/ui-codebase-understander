import { Edge } from '../graph/types';
import { indexEdgesFrom, indexEdgesTo } from '../analysis/edges';

/**
 * Finds the edges that close a circle, so the layout can ignore them and still go left to right.
 * @param childIds A parent's children, most important first. Earlier children win the left side of a circle.
 * @param edges The edges between those children, from liftEdges.
 * @returns The edges to ignore when assigning columns.
 */
export function findBackEdges(childIds: string[], edges: Edge[]): Set<Edge> {
	// each child's outgoing edges, so the search doesn't rescan every edge at every step
	const outgoing = indexEdgesFrom(edges);

	// children we have entered at all, and children on the route we are walking now
	const visited = new Set<string>();
	const onPath = new Set<string>();
	const backEdges = new Set<Edge>();

	function visit(id: string): void {
		visited.add(id);
		onPath.add(id);

		for (const edge of outgoing.get(id) ?? []) {
			if (onPath.has(edge.to)) {
				// the target is behind us on this route, so this edge closes a circle
				backEdges.add(edge);
			} else if (!visited.has(edge.to)) {
				visit(edge.to);
			}
		}

		// back up: this child is finished and no longer on the route
		onPath.delete(id);
	}

	// one walk may not reach everything, so start from every child not yet visited, most important first
	for (const id of childIds) {
		if (!visited.has(id)) {
			visit(id);
		}
	}

	return backEdges;
}

/**
 * Puts each child one column right of the furthest-right child with an edge into it, so edges point rightward.
 * @param childIds A parent's children, most important first.
 * @param edges The edges between those children, from liftEdges.
 * @returns Each child's column, starting from 0.
 */
export function assignColumns(childIds: string[], edges: Edge[]): Map<string, number> {
	const backEdges = findBackEdges(childIds, edges);

	// every edge except the ones that close a circle
	const forwardEdges: Edge[] = [];
	for (const edge of edges) {
		if (!backEdges.has(edge)) {
			forwardEdges.push(edge);
		}
	}

	// each child's incoming edges, so columnOf can ask who points at it
	const incoming = indexEdgesTo(forwardEdges);

	// filled in as we go, so each child's column is worked out once
	const columns = new Map<string, number>();

	function columnOf(id: string): number {
		const known = columns.get(id);
		if (known !== undefined) {
			return known;
		}

		// nothing points here: column 0. Otherwise one right of the furthest-right child pointing here
		let column = 0;
		for (const edge of incoming.get(id) ?? []) {
			column = Math.max(column, columnOf(edge.from) + 1);
		}

		columns.set(id, column);
		return column;
	}

	for (const id of childIds) {
		columnOf(id);
	}

	return columns;
}
