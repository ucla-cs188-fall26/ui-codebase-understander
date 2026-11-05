import { Edge, Node } from './types';

// box sizes in pixels, starting guesses to tune once the graph is on screen
const MIN_WIDTH = 120;
const MAX_WIDTH = 260;
const MIN_HEIGHT = 36;
const MAX_HEIGHT = 84;

// the score at which a box reaches its maximum size
const MAX_SCORE = 16;

/**
 * Works out how big a node's box should be.
 * @param childCount The node's direct children.
 * @param indegree The imports entering the node from outside it.
 * @returns The box width and height in pixels.
 */
export function nodeSize(childCount: number, indegree: number): { width: number; height: number } {
	// log2 stops one heavily imported file from dwarfing everything else
	const score = Math.log2(1 + childCount) + 2 * Math.log2(1 + indegree);
	const scale = Math.min(score / MAX_SCORE, 1);

	return {
		width: MIN_WIDTH + scale * (MAX_WIDTH - MIN_WIDTH),
		height: MIN_HEIGHT + scale * (MAX_HEIGHT - MIN_HEIGHT),
	};
}

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
 * Lists a node and everything above it, up to the root.
 * @param id The node to start from.
 * @param nodesById Every node in the graph, by id.
 * @returns The ids from the node itself up to the root.
 */
function getLineage(id: string, nodesById: Map<string, Node>): string[] {
	const lineage: string[] = [];
	let currentId: string | null = id;
	while (currentId !== null) {
		lineage.push(currentId);
		currentId = nodesById.get(currentId)!.parent;
	}
	return lineage;
}

/**
 * Counts the imports entering each node from outside it.
 * @param nodesById Every node in the graph, by id.
 * @param edges Every edge in the graph.
 * @returns A map from node id to its indegree.
 */
export function computeIndegrees(nodesById: Map<string, Node>, edges: Edge[]): Map<string, number> {
	const indegrees = new Map<string, number>();
	for (const id of nodesById.keys()) {
		indegrees.set(id, 0);
	}

	for (const edge of edges) {
		const fromLineage = new Set(getLineage(edge.from, nodesById));
		const toLineage = getLineage(edge.to, nodesById);

		// walk up from the target until reaching a node that also contains the source
		for (const id of toLineage) {
			if (fromLineage.has(id)) {
				break;
			}
			indegrees.set(id, indegrees.get(id)! + 1);
		}
	}

	return indegrees;
}
