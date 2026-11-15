import { Edge, Node } from '../graph/types';
import { getLineage } from './lookups';

/**
 * Counts the edges entering each node from outside it.
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

/**
 * Scores how much a node matters, from its size and how much depends on it.
 * @param childCount The node's direct children.
 * @param indegree The edges entering the node from outside it.
 * @returns 0 for a lone node with no incoming edges, growing slowly from there.
 */
export function importanceScore(childCount: number, indegree: number): number {
	// log2 stops one node with many incoming edges from dwarfing everything else
	return Math.log2(1 + childCount) + 2 * Math.log2(1 + indegree);
}

/**
 * Sorts a parent's children, most important first.
 * @param childIds The ids to sort.
 * @param nodesById Every node in the graph, by id.
 * @param indegrees Every node's indegree, by id.
 * @returns A sorted copy: highest indegree, then most children, then alphabetical.
 */
export function sortChildren(
	childIds: string[],
	nodesById: Map<string, Node>,
	indegrees: Map<string, number>,
): string[] {
	function compareImportance(a: string, b: string): number {
		const indegreeDifference = indegrees.get(b)! - indegrees.get(a)!;
		if (indegreeDifference !== 0) {
			return indegreeDifference;
		}

		const childCountDifference = nodesById.get(b)!.childCount - nodesById.get(a)!.childCount;
		if (childCountDifference !== 0) {
			return childCountDifference;
		}

		return a < b ? -1 : 1;
	}

	return childIds.toSorted(compareImportance);
}

/**
 * Sorts every parent's children. Call this once per graph and share the result.
 * @param childrenById The lookup from indexChildren.
 * @param nodesById Every node in the graph, by id.
 * @param indegrees Every node's indegree, by id.
 * @returns A new lookup with each parent's children sorted by importance.
 */
export function sortAllChildren(
	childrenById: Map<string, string[]>,
	nodesById: Map<string, Node>,
	indegrees: Map<string, number>,
): Map<string, string[]> {
	const sortedChildrenById = new Map<string, string[]>();
	for (const [parentId, childIds] of childrenById) {
		sortedChildrenById.set(parentId, sortChildren(childIds, nodesById, indegrees));
	}
	return sortedChildrenById;
}
