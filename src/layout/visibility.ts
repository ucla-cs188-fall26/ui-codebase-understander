import { ROOT_ID } from '../graph/types';

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