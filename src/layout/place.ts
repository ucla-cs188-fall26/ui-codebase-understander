import { Edge, ROOT_ID } from '../graph/types';
import { getLineage } from '../analysis/lookups';
import { keepOnePerPair } from '../analysis/edges';
import { Position, Rect } from './geometry';
import { arrangeChildren, childOrigin, GraphInfo, LayoutState } from './state';

/**
 * Works out where every visible box sits on the page, from homes that are relative to their parents.
 * @param state The view state. Every open box's shown children must have homes.
 * @param info The graph lookups.
 * @param origin Where the root's children are measured from on the page.
 * @returns Every visible box's page rect, parents before their children, which is also the order to paint them.
 */
export function placeBoxes(state: LayoutState, info: GraphInfo, origin: Position): Map<string, Rect> {
	const rects = new Map<string, Rect>();

	function placeChildren(parentId: string, inside: Position): void {
		// arranged rects are relative to the parent and already pushed clear of each other
		for (const [id, arranged] of arrangeChildren(state, info, parentId)) {
			const rect = { x: inside.x + arranged.x, y: inside.y + arranged.y, width: arranged.width, height: arranged.height };
			rects.set(id, rect);

			// an open box's children sit inside it, below its name
			if (state.expanded.has(id)) {
				const offset = childOrigin();
				placeChildren(id, { x: rect.x + offset.x, y: rect.y + offset.y });
			}
		}
	}

	// the root has no box of its own, so its children start right at the origin
	placeChildren(ROOT_ID, origin);
	return rects;
}

/**
 * Numbers the boxes in paint order, so later boxes draw on top.
 * @param rects Every visible box, from placeBoxes, parents before their children.
 * @returns Each box's z-index: 2, 4, 6, ... leaving the odd number above each box free for arrows.
 */
export function boxZIndexes(rects: Map<string, Rect>): Map<string, number> {
	const zIndexes = new Map<string, number>();
	let next = 2;
	for (const id of rects.keys()) {
		zIndexes.set(id, next);
		next += 2;
	}
	return zIndexes;
}

/**
 * Picks how high an arrow paints: just above the open boxes that hold its ends, so their backgrounds don't
 * hide it, and below everything else.
 * @param edge The arrow's edge, between visible boxes.
 * @param state The view state.
 * @param info The graph lookups.
 * @param boxZ Every box's z-index, from boxZIndexes.
 * @returns One more than the highest open box holding either end, or 1 if no open box holds one.
 */
export function arrowZIndex(edge: Edge, state: LayoutState, info: GraphInfo, boxZ: Map<string, number>): number {
	let highest = 0;
	for (const end of [edge.from, edge.to]) {
		for (const ancestorId of getLineage(end, info.nodesById)) {
			// the root is open but has no box, so it has no z-index and is skipped
			const z = boxZ.get(ancestorId);
			if (z !== undefined && state.expanded.has(ancestorId)) {
				highest = Math.max(highest, z);
			}
		}
	}
	return highest + 1;
}

/**
 * Finds the deepest visible box that is a node or contains it.
 * @param id The node.
 * @param info The graph lookups.
 * @param rects Every visible box, from placeBoxes.
 * @returns The box's id, or undefined if even the node's top-level ancestor is hidden.
 */
function visibleBoxContaining(id: string, info: GraphInfo, rects: Map<string, Rect>): string | undefined {
	for (const ancestorId of getLineage(id, info.nodesById)) {
		if (rects.has(ancestorId)) {
			return ancestorId;
		}
	}
	return undefined;
}

/**
 * Turns every edge in the graph into an edge between the visible boxes holding its ends.
 * @param state The view state.
 * @param info The graph lookups.
 * @param rects Every visible box, from placeBoxes.
 * @returns One edge per pair of visible boxes with an edge between them, in the order first seen.
 */
export function visibleEdges(state: LayoutState, info: GraphInfo, rects: Map<string, Rect>): Edge[] {
	const edges: Edge[] = [];

	for (const edge of info.edges) {
		const from = visibleBoxContaining(edge.from, info, rects);
		const to = visibleBoxContaining(edge.to, info, rects);
		if (from === undefined || to === undefined) {
			continue;
		}

		// landing on an open box means the node is hidden behind its "+N more"; strips will take these later
		if (state.expanded.has(from) || state.expanded.has(to)) {
			continue;
		}

		// both ends inside one closed box: no arrow
		if (from === to) {
			continue;
		}

		edges.push({ from: from, to: to, kind: edge.kind });
	}

	// many edges can land on the same two visible boxes
	return keepOnePerPair(edges);
}
