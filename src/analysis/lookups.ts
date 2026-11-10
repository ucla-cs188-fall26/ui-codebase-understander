import { Node } from '../graph/types';

/**
 * Builds the id-to-node lookup. Call this once per graph and share the result.
 * @param nodes Every node in the graph.
 * @returns A map from node id to node.
 */
export function indexNodes(nodes: Node[]): Map<string, Node> {
	const nodesById = new Map<string, Node>();
	for (const node of nodes) {
		nodesById.set(node.id, node);
	}
	return nodesById;
}

/**
 * Builds the folder-to-children lookup. Call this once per graph and share the result.
 * @param nodes Every node in the graph.
 * @returns A map from each folder's id to its children's ids.
 */
export function indexChildren(nodes: Node[]): Map<string, string[]> {
	const childrenById = new Map<string, string[]>();
	for (const node of nodes) {
		if (node.parent === null) {
			continue;
		}

		const siblings = childrenById.get(node.parent) ?? [];
		siblings.push(node.id);
		childrenById.set(node.parent, siblings);
	}
	return childrenById;
}

/**
 * Lists a node and everything above it, up to the root.
 * @param id The node to start from.
 * @param nodesById Every node in the graph, by id.
 * @returns The ids from the node itself up to the root.
 */
export function getLineage(id: string, nodesById: Map<string, Node>): string[] {
	const lineage: string[] = [];
	let currentId: string | null = id;
	while (currentId !== null) {
		lineage.push(currentId);
		currentId = nodesById.get(currentId)!.parent;
	}
	return lineage;
}
