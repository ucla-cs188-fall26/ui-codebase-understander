import { Edge, ROOT_ID } from '../graph/types';
import { getLineage } from '../analysis/lookups';
import { findChildContaining, keepOnePerPair } from '../analysis/edges';
import { GAP } from './defaultLayout';
import { boundsOf, Position, Rect } from './geometry';
import { arrangeShown, childOrigin, GraphInfo, LayoutState, STRIP_THICKNESS } from './state';

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
		for (const [id, arranged] of arrangeShown(state, info, parentId).rects) {
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
		// a strip end counts as its box, which is open, so the arrow sits just above it
		for (const ancestorId of getLineage(nodeOfEnd(end), info.nodesById)) {
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
 * Turns an arrow end into the node it stands for: a strip's box for a strip, and the node itself otherwise.
 * @param id An edge end: a node's id, or a strip's id from stripId.
 * @returns A node's id, safe to look up or walk the lineage of.
 */
export function nodeOfEnd(id: string): string {
	const newline = id.indexOf('\n');
	return newline === -1 ? id : id.slice(0, newline);
}

/**
 * Finds the strip hiding a node, among one box's strips.
 * @param id The hidden node, or something inside it.
 * @param ownerId The open box it's hidden in.
 * @param info The graph lookups.
 * @param strips Every strip, from placeStrips.
 * @returns The strip's id, or undefined if none of the box's strips hides it.
 */
function stripHiding(id: string, ownerId: string, info: GraphInfo, strips: Strip[]): string | undefined {
	const child = findChildContaining(id, ownerId, info.nodesById);
	for (const strip of strips) {
		if (strip.ownerId === ownerId && child !== undefined && strip.hiddenIds.includes(child)) {
			return strip.id;
		}
	}
	return undefined;
}

/**
 * Finds what an edge end attaches to: the deepest visible box holding it, or, when it's hidden, the strip it's behind.
 * @param id The edge end, a node in the graph.
 * @param state The view state.
 * @param info The graph lookups.
 * @param rects Every visible box.
 * @param strips Every strip.
 * @returns A box's or strip's id, or undefined if the end can't be shown at all.
 */
function endpointOf(id: string, state: LayoutState, info: GraphInfo, rects: Map<string, Rect>, strips: Strip[]): string | undefined {
	const box = visibleBoxContaining(id, info, rects);

	// not even its top-level box is shown, so it's behind the root's strip, if any
	if (box === undefined) {
		return stripHiding(id, ROOT_ID, info, strips);
	}

	// landing on an open box means it's hidden inside it, behind one of its strips
	if (state.expanded.has(box)) {
		return stripHiding(id, box, info, strips);
	}

	return box;
}

/**
 * Turns every edge in the graph into an edge between the visible boxes holding its ends, or the strips hiding them.
 * @param state The view state.
 * @param info The graph lookups.
 * @param rects Every visible box, from placeBoxes.
 * @param strips Every strip, from placeStrips. Without them, edges to hidden nodes are left out.
 * @returns One edge per pair of ends with an edge between them, in the order first seen.
 */
export function visibleEdges(state: LayoutState, info: GraphInfo, rects: Map<string, Rect>, strips: Strip[] = []): Edge[] {
	const edges: Edge[] = [];

	for (const edge of info.edges) {
		const from = endpointOf(edge.from, state, info, rects, strips);
		const to = endpointOf(edge.to, state, info, rects, strips);
		if (from === undefined || to === undefined) {
			continue;
		}

		// both ends inside one closed box, or behind one strip: no arrow
		if (from === to) {
			continue;
		}

		edges.push({ from: from, to: to, kind: edge.kind });
	}

	// many edges can land on the same two visible boxes
	return keepOnePerPair(edges);
}

export type StripSide = 'right' | 'bottom';

// a "+N" bar along a box's edge, standing in for the children it's hiding on that side
export interface Strip {
	id: string; // from stripId, so arrows can end at it like at a box
	ownerId: string; // the box it belongs to; the root's strip sits beside the top-level boxes
	side: StripSide;
	rect: Rect; // on the page
	hiddenIds: string[]; // in flow order
}

/**
 * Names a strip so arrows can end at it. A newline separates the box from the side, since it practically never
 * appears in a path.
 * @param ownerId The box the strip belongs to.
 * @param side Which side of the box.
 * @returns The strip's id.
 */
export function stripId(ownerId: string, side: StripSide): string {
	return ownerId + '\n' + side;
}

/**
 * Works out where every strip goes: inside each open box hiding children on that side, one padding in from its right
 * or bottom edge, in room the box keeps for it, so the padding is even all around; and for the root, just below the
 * top-level boxes.
 * @param state The view state.
 * @param info The graph lookups.
 * @param rects Every visible box, from placeBoxes.
 * @returns One strip per side that hides something.
 */
export function placeStrips(state: LayoutState, info: GraphInfo, rects: Map<string, Rect>): Strip[] {
	const strips: Strip[] = [];

	// childOrigin's x is the padding, and its y is the title plus the padding
	const origin = childOrigin();
	const padding = origin.x;
	const title = origin.y - origin.x;

	// a strip and the padding before it; where both strips are there, each stops short of the other's corner
	const room = STRIP_THICKNESS + padding;

	for (const id of state.expanded) {
		const box = rects.get(id);
		if (id === ROOT_ID || box === undefined) {
			continue;
		}

		const shown = arrangeShown(state, info, id);
		const hasRight = shown.hiddenRight.length > 0;
		const hasBottom = shown.hiddenBottom.length > 0;
		if (hasRight) {
			strips.push({
				id: stripId(id, 'right'),
				ownerId: id,
				side: 'right',
				rect: {
					x: box.x + box.width - padding - STRIP_THICKNESS,
					y: box.y + title + padding,
					width: STRIP_THICKNESS,
					height: box.height - title - 2 * padding - (hasBottom ? room : 0),
				},
				hiddenIds: shown.hiddenRight,
			});
		}
		if (hasBottom) {
			strips.push({
				id: stripId(id, 'bottom'),
				ownerId: id,
				side: 'bottom',
				rect: {
					x: box.x + padding,
					y: box.y + box.height - padding - STRIP_THICKNESS,
					width: box.width - 2 * padding - (hasRight ? room : 0),
					height: STRIP_THICKNESS,
				},
				hiddenIds: shown.hiddenBottom,
			});
		}
	}

	// the root has no box: nodes outside the flow wait in a strip just below the top-level boxes, as wide as them
	const rootShown = arrangeShown(state, info, ROOT_ID);
	const topLevel: Rect[] = [];
	for (const id of rootShown.rects.keys()) {
		topLevel.push(rects.get(id)!);
	}
	const bounds = boundsOf(topLevel);
	if (rootShown.hiddenBottom.length > 0 && bounds !== undefined) {
		strips.push({
			id: stripId(ROOT_ID, 'bottom'),
			ownerId: ROOT_ID,
			side: 'bottom',
			rect: { x: bounds.x, y: bounds.y + bounds.height + GAP, width: bounds.width, height: STRIP_THICKNESS },
			hiddenIds: rootShown.hiddenBottom,
		});
	}

	return strips;
}
