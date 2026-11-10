import { Edge, Node } from '../graph/types';
import { getLineage } from './lookups';

/**
 * Builds the node-to-outgoing-edges lookup.
 * @param edges The edges to index.
 * @returns A map from each node id to the edges leaving it. Nodes with none are left out.
 */
export function indexEdgesFrom(edges: Edge[]): Map<string, Edge[]> {
	const edgesById = new Map<string, Edge[]>();
	for (const edge of edges) {
		const fromEdges = edgesById.get(edge.from) ?? [];
		fromEdges.push(edge);
		edgesById.set(edge.from, fromEdges);
	}
	return edgesById;
}

/**
 * Builds the node-to-incoming-edges lookup.
 * @param edges The edges to index.
 * @returns A map from each node id to the edges entering it. Nodes with none are left out.
 */
export function indexEdgesTo(edges: Edge[]): Map<string, Edge[]> {
	const edgesById = new Map<string, Edge[]>();
	for (const edge of edges) {
		const toEdges = edgesById.get(edge.to) ?? [];
		toEdges.push(edge);
		edgesById.set(edge.to, toEdges);
	}
	return edgesById;
}

/**
 * Finds which direct child of a parent holds a node, so nested nodes can stand in for their containers.
 * @param id The node to look for.
 * @param parentId The parent whose children we want.
 * @param nodesById Every node in the graph, by id.
 * @returns The direct child that is the node or contains it, or undefined if the node is outside the parent.
 */
export function findChildContaining(id: string, parentId: string, nodesById: Map<string, Node>): string | undefined {
	for (const ancestorId of getLineage(id, nodesById)) {
		if (nodesById.get(ancestorId)!.parent === parentId) {
			return ancestorId;
		}
	}
	return undefined;
}

/**
 * Turns every edge inside a parent into an edge between its direct children.
 * @param parentId The parent to look inside.
 * @param edges Every edge in the graph.
 * @param nodesById Every node in the graph, by id.
 * @returns One edge per pair of children with an edge between them, in the order first seen.
 */
export function liftEdges(parentId: string, edges: Edge[], nodesById: Map<string, Node>): Edge[] {
	const liftedEdges: Edge[] = [];

	// which children each child already has an edge to, so each pair is added once
	const targetsByChild = new Map<string, Set<string>>();

	for (const edge of edges) {
		const from = findChildContaining(edge.from, parentId, nodesById);
		const to = findChildContaining(edge.to, parentId, nodesById);

		// an end outside the parent: this edge belongs to a level further up
		if (from === undefined || to === undefined) {
			continue;
		}

		// both ends inside the same child: an edge within one box, so no arrow at this level
		if (from === to) {
			continue;
		}

		const targets = targetsByChild.get(from) ?? new Set<string>();
		if (targets.has(to)) {
			continue;
		}
		targets.add(to);
		targetsByChild.set(from, targets);

		liftedEdges.push({ from: from, to: to, kind: edge.kind });
	}

	return liftedEdges;
}
