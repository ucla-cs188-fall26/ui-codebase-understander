import { Node, ROOT_ID } from '../graph/types';

// how many children a folder shows, and how many more each click reveals
export const CHILD_LIMIT = 5;

// stands in for the children a folder is hiding, shown as "+N more"
export interface MoreBox {
	id: string;
	parent: string;
	hiddenIds: string[];
}

export interface VisibleGraph {
	nodeIds: string[];
	moreBoxes: MoreBox[];
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
 * Sorts a folder's children, most important first.
 * @param childIds The ids to sort.
 * @param nodesById Every node in the graph, by id.
 * @param indegrees Every node's indegree, by id.
 * @returns A sorted copy: highest indegree, then most children, then alphabetical.
 */
export function sortChildrenOfFolder(
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
 * Sorts every folder's children. Call this once per graph and share the result.
 * @param childrenById The lookup from indexChildren.
 * @param nodesById Every node in the graph, by id.
 * @param indegrees Every node's indegree, by id.
 * @returns A new lookup with each folder's children sorted by importance.
 */
export function sortChildrenOfAllFolders(
	childrenById: Map<string, string[]>,
	nodesById: Map<string, Node>,
	indegrees: Map<string, number>,
): Map<string, string[]> {
	const sortedChildrenById = new Map<string, string[]>();
	for (const [folderId, childIds] of childrenById) {
		sortedChildrenById.set(folderId, sortChildrenOfFolder(childIds, nodesById, indegrees));
	}
	return sortedChildrenById;
}

/**
 * Finds the nodes to show, given which folders are expanded.
 * @param childrenById The lookup from indexChildren.
 * @param expanded The ids of the expanded folders. The root is always open.
 * @param revealed How many children each folder shows, for folders past the default limit.
 * @returns The visible node ids, parents before their children, and any "+N more" boxes.
 */
export function getVisibleNodes(
	childrenById: Map<string, string[]>,
	expanded: Set<string>,
	revealed: Map<string, number>,
): VisibleGraph {
	const nodeIds: string[] = [];
	const moreBoxes: MoreBox[] = [];

	function visit(id: string): void {
		nodeIds.push(id);

		const isOpen = id === ROOT_ID || expanded.has(id);
		if (!isOpen) {
			return;
		}

		const children = childrenById.get(id) ?? [];
		const shownCount = revealed.get(id) ?? CHILD_LIMIT;
		const shownIds = children.slice(0, shownCount);
		const hiddenIds = children.slice(shownCount);

		for (const childId of shownIds) {
			visit(childId);
		}

		if (hiddenIds.length > 0) {
			moreBoxes.push({ id: id + '#more', parent: id, hiddenIds: hiddenIds });
		}
	}

	visit(ROOT_ID);
	return { nodeIds: nodeIds, moreBoxes: moreBoxes };
}