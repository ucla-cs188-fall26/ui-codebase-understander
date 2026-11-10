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
 * Drops repeats, so each pair of nodes has at most one edge in each direction.
 * @param edges The edges, possibly with several between the same two nodes.
 * @returns The first edge of each pair, in the original order.
 */
export function keepOnePerPair(edges: Edge[]): Edge[] {
	const kept: Edge[] = [];

	// which nodes each node already has an edge to
	const targetsById = new Map<string, Set<string>>();

	for (const edge of edges) {
		const targets = targetsById.get(edge.from) ?? new Set<string>();
		if (targets.has(edge.to)) {
			continue;
		}
		targets.add(edge.to);
		targetsById.set(edge.from, targets);
		kept.push(edge);
	}

	return kept;
}

/**
 * Checks whether a node is a container or anywhere inside it.
 * @param nodeId The node.
 * @param containerId The possible container.
 * @param nodesById Every node in the graph, by id.
 * @returns True if the node is the container or one of its descendants.
 */
export function isInside(nodeId: string, containerId: string, nodesById: Map<string, Node>): boolean {
	return getLineage(nodeId, nodesById).includes(containerId);
}

/**
 * Lists what a node connects to across its boundary: for a folder, edges between its insides and the rest of the graph.
 * @param id The node.
 * @param edges Every edge in the graph.
 * @param nodesById Every node in the graph, by id.
 * @returns The nodes outside it that it has edges to, and the ones with edges into it, each once, in edge order.
 */
export function connections(id: string, edges: Edge[], nodesById: Map<string, Node>): { outgoing: string[]; incoming: string[] } {
	const outgoing = new Set<string>();
	const incoming = new Set<string>();

	for (const edge of edges) {
		const fromInside = isInside(edge.from, id, nodesById);
		const toInside = isInside(edge.to, id, nodesById);

		// only edges crossing the boundary: one end inside, the other outside
		if (fromInside && !toInside) {
			outgoing.add(edge.to);
		}
		if (!fromInside && toInside) {
			incoming.add(edge.from);
		}
	}

	return { outgoing: Array.from(outgoing), incoming: Array.from(incoming) };
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

		liftedEdges.push({ from: from, to: to, kind: edge.kind });
	}

	// many nested edges can land on the same two children
	return keepOnePerPair(liftedEdges);
}
