import { Edge, ROOT_ID } from '../graph/types';
import { getLineage } from '../analysis/lookups';
import { findChildContaining, isInside } from '../analysis/edges';
import { Position, Rect } from './geometry';
import { arrangeShown, boxSize, childOrigin, GraphInfo, HEADER, LayoutState, PADDING, STRIP_THICKNESS, StripSide } from './state';

/**
 * Works out where every visible box sits on the page, from homes that are relative to their parents. The root is a box
 * too, around everything.
 * @param state The view state. Every open box's shown children must have homes.
 * @param info The graph lookups.
 * @param origin Where the root's top-left goes on the page.
 * @returns Every visible box's page rect, parents before their children, which is also the order to paint them.
 */
export function placeBoxes(state: LayoutState, info: GraphInfo, origin: Position): Map<string, Rect> {
	const rects = new Map<string, Rect>();

	function placeChildren(parentId: string, inside: Position): void {
		// arranged rects are relative to the parent and already pushed clear of each other
		for (const [id, arranged] of arrangeShown(state, info, parentId).rects) {
			const rect = { x: inside.x + arranged.x, y: inside.y + arranged.y, width: arranged.width, height: arranged.height };
			rects.set(id, rect);

			// an open box's children sit inside it, below its name, past any strip on its left or top
			if (state.expanded.has(id)) {
				const offset = childOrigin(state, info, id);
				placeChildren(id, { x: rect.x + offset.x, y: rect.y + offset.y });
			}
		}
	}

	// the root's box, then everything inside it
	const rootSize = boxSize(state, info, ROOT_ID);
	rects.set(ROOT_ID, { x: origin.x, y: origin.y, width: rootSize.width, height: rootSize.height });
	const rootOffset = childOrigin(state, info, ROOT_ID);
	placeChildren(ROOT_ID, { x: origin.x + rootOffset.x, y: origin.y + rootOffset.y });
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
			// every open box holding an end counts, the root included
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
 * Checks whether an arrow belongs to a box: it carries at least one edge that starts or ends in the box or inside it.
 * Checking the edges it carries, not where it's drawn, means a file's arrows light up even when they've been grouped
 * into its folder's.
 * @param edge The arrow, from visibleEdges.
 * @param id The box.
 * @param info The graph lookups.
 * @returns True if any edge it carries has an end in the box.
 */
export function arrowTouches(edge: VisibleEdge, id: string, info: GraphInfo): boolean {
	for (const graphEdge of edge.edges) {
		if (isInside(graphEdge.from, id, info.nodesById) || isInside(graphEdge.to, id, info.nodesById)) {
			return true;
		}
	}
	return false;
}

/**
 * Finds the boxes an arrow passes under: every box except its ends and the open boxes holding them. Only the outermost
 * count, since a box inside one is covered by it; that also keeps them apart, so each can be cut out of the arrow on
 * its own.
 * @param edge The arrow's edge, between visible boxes or strips.
 * @param info The graph lookups.
 * @param rects Every visible box, from placeBoxes.
 * @returns The ids of the boxes it passes under.
 */
export function boxesUnderArrow(edge: Edge, info: GraphInfo, rects: Map<string, Rect>): string[] {
	// its ends, and every box around them; a strip end counts as its box
	const holding = new Set<string>();
	for (const end of [edge.from, edge.to]) {
		for (const id of getLineage(nodeOfEnd(end), info.nodesById)) {
			holding.add(id);
		}
	}

	// the outermost of the rest: boxes whose parent holds an end (the root holds everything)
	const under: string[] = [];
	for (const id of rects.keys()) {
		const parentId = info.nodesById.get(id)!.parent!;
		if (!holding.has(id) && holding.has(parentId)) {
			under.push(id);
		}
	}
	return under;
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
export function visibleEndpointOf(id: string, state: LayoutState, info: GraphInfo, rects: Map<string, Rect>, strips: Strip[]): string | undefined {
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
 * Finds the deepest node holding both of two nodes: the folder an arrow between them lives in.
 * @param a One node.
 * @param b The other node.
 * @param info The graph lookups.
 * @returns The id of the deepest node both are inside, or the root.
 */
function commonAncestor(a: string, b: string, info: GraphInfo): string {
	const aboveA = new Set(getLineage(a, info.nodesById));
	for (const id of getLineage(b, info.nodesById)) {
		if (aboveA.has(id)) {
			return id;
		}
	}
	return ROOT_ID;
}

/**
 * Moves an arrow end up to its folder at a depth, when it's deeper. A strip counts as one level inside its box, since it
 * stands for that box's children.
 * @param end A box's or strip's id.
 * @param depth The deepest it may be, where top-level boxes are 1.
 * @param info The graph lookups.
 * @returns The end, or its folder at that depth.
 */
function endAtDepth(end: string, depth: number, info: GraphInfo): string {
	// the lineage runs from the node up to the root, so a node at depth d has d + 1 entries
	const nodeId = nodeOfEnd(end);
	const lineage = getLineage(nodeId, info.nodesById);
	let endDepth = lineage.length - 1;
	if (end !== nodeId) {
		endDepth++;
	}
	if (endDepth <= depth) {
		return end;
	}
	return lineage[lineage.length - 1 - depth];
}

/**
 * Finds what an edge's two ends attach to: the visible box or strip holding each, grouped so neither is more than
 * maxDepth levels below the folder the edge lives in.
 * @param edge An edge in the graph.
 * @param state The view state.
 * @param info The graph lookups.
 * @param rects Every visible box.
 * @param strips Every strip.
 * @param maxDepth How many levels below the edge's folder its ends may go; Infinity for no limit.
 * @returns Both ends' box or strip ids, or undefined if either can't be shown at all.
 */
export function arrowEndsOf(edge: Edge, state: LayoutState, info: GraphInfo, rects: Map<string, Rect>, strips: Strip[], maxDepth: number): { from: string; to: string } | undefined {
	let from = visibleEndpointOf(edge.from, state, info, rects, strips);
	let to = visibleEndpointOf(edge.to, state, info, rects, strips);
	if (from === undefined || to === undefined) {
		return undefined;
	}
	// the folder it lives in has depth (its lineage's length - 1); the ends may go maxDepth below that. With no limit
	// (Infinity), every end is already within it
	const home = commonAncestor(edge.from, edge.to, info);
	const limit = getLineage(home, info.nodesById).length - 1 + maxDepth;
	from = endAtDepth(from, limit, info);
	to = endAtDepth(to, limit, info);
	return { from: from, to: to };
}

// one row in the sidebar's lists of what a box connects to: a node, how many imports go through it, and the rows
// inside it, most imports first
export interface LinkGroup {
	id: string;
	count: number;
	children: LinkGroup[];
}

/**
 * Groups what a box connects to the way its arrows are grouped: each far node is lifted to its folder at the depth
 * setting, measured from the folder the box and that node share, which makes a top row; the rows under it follow the
 * folders down to the node itself.
 * @param selectedId The box whose connections these are.
 * @param counts Each node at the far end, with how many imports go to or from it, from connections.
 * @param info The graph lookups.
 * @param maxDepth The arrow settings' depth.
 * @returns The top rows, most imports first, each holding its rows below.
 */
export function groupLinks(selectedId: string, counts: Map<string, number>, info: GraphInfo, maxDepth: number): LinkGroup[] {
	// at the depth setting, measured from the folder the box and each node share, like the arrows
	function startDepth(farId: string): number {
		const shared = commonAncestor(selectedId, farId, info);
		return getLineage(shared, info.nodesById).length - 1 + maxDepth;
	}
	return buildLinkRows(counts, info, startDepth);
}

/**
 * Groups the nodes inside a box by the folders they're in, starting one level inside the box, as if it were opened.
 * A box that's a file is its own single row.
 * @param boxId The box.
 * @param counts Each node inside it, with how many imports go through it.
 * @param info The graph lookups.
 * @returns The top rows, most imports first, each holding its rows below.
 */
export function groupInside(boxId: string, counts: Map<string, number>, info: GraphInfo): LinkGroup[] {
	// a lineage runs from the node up to the root, so the box's children are as deep as its lineage is long
	const insideDepth = getLineage(boxId, info.nodesById).length;
	function startDepth(): number {
		return insideDepth;
	}
	return buildLinkRows(counts, info, startDepth);
}

/**
 * Builds rows from nodes and their counts: each node's row sits under the rows of the folders it's in, from a depth
 * the caller picks down to the node; a row's count is the total of the nodes under it.
 * @param counts Each node, with how many imports go through it.
 * @param info The graph lookups.
 * @param startDepth For a node, the depth its top row is at (top-level boxes are 1). Deeper than the node itself means
 *   the node is its own top row.
 * @returns The top rows, most imports first, each holding its rows below.
 */
function buildLinkRows(counts: Map<string, number>, info: GraphInfo, startDepth: (id: string) => number): LinkGroup[] {
	// built with maps so each row is found by id, then turned into sorted lists
	interface Building {
		id: string;
		count: number;
		children: Map<string, Building>;
	}
	const top = new Map<string, Building>();

	for (const [farId, count] of counts) {
		// a lineage from the root down, so entry k is at depth k
		const lineage = getLineage(farId, info.nodesById).reverse();
		const limit = startDepth(farId);

		// from the folder at the start depth (or the node itself, if it's shallower) down to the node
		let level = top;
		for (let depth = Math.min(limit, lineage.length - 1); depth < lineage.length; depth++) {
			const id = lineage[depth];
			let row = level.get(id);
			if (row === undefined) {
				row = { id: id, count: 0, children: new Map() };
				level.set(id, row);
			}
			row.count += count;
			level = row.children;
		}
	}

	function mostFirst(a: LinkGroup, b: LinkGroup): number {
		if (a.count !== b.count) {
			return b.count - a.count;
		}
		return a.id.localeCompare(b.id);
	}
	function finish(rows: Map<string, Building>): LinkGroup[] {
		const list: LinkGroup[] = [];
		for (const row of rows.values()) {
			list.push({ id: row.id, count: row.count, children: finish(row.children) });
		}
		return list.sort(mostFirst);
	}
	return finish(top);
}

// an arrow between two visible boxes or strips, standing for one or more of the graph's edges
export interface VisibleEdge extends Edge {
	count: number; // how many of the graph's edges it stands for
	edges: Edge[]; // those edges, in the graph's order
}

/**
 * Turns every edge in the graph into an edge between the visible boxes holding its ends, or the strips hiding them.
 * @param state The view state.
 * @param info The graph lookups.
 * @param rects Every visible box, from placeBoxes.
 * @param strips Every strip, from placeStrips. Without them, edges to hidden nodes are left out.
 * @param maxDepth How many levels below the folder an edge lives in its ends may go, from the toolbar; deeper ends
 *   attach to their folder at that level. Infinity for no limit.
 * @returns One edge per pair of ends with an edge between them, in the order first seen, each with the graph's edges
 *   that landed on it.
 */
export function visibleEdges(state: LayoutState, info: GraphInfo, rects: Map<string, Rect>, strips: Strip[] = [], maxDepth: number = Infinity): VisibleEdge[] {
	// one per pair of ends, in the order first seen, counting the edges that land on it
	const byEnds = new Map<string, VisibleEdge>();

	for (const edge of info.edges) {
		const ends = arrowEndsOf(edge, state, info, rects, strips, maxDepth);
		if (ends === undefined) {
			continue;
		}
		const from = ends.from;
		const to = ends.to;

		// both ends inside one closed box, or behind one strip: no arrow
		if (from === to) {
			continue;
		}

		// many edges can land on the same two visible boxes. A strip's id has a newline in it, so the two ends are
		// joined with a character ids never have
		const key = from + '\u0000' + to;
		const known = byEnds.get(key);
		if (known !== undefined) {
			known.count++;
			known.edges.push(edge);
		} else {
			byEnds.set(key, { from: from, to: to, kind: edge.kind, count: 1, edges: [edge] });
		}
	}

	return Array.from(byEnds.values());
}

export type { StripSide };

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
 * Works out where every strip goes: inside each open box hiding children on that side, one padding in from that edge,
 * in room the box keeps for it, so the padding is even all around; and for the root, just below the top-level boxes.
 * Side strips run between the top and bottom ones, and top and bottom strips between the side ones, so none overlap.
 * @param state The view state.
 * @param info The graph lookups.
 * @param rects Every visible box, from placeBoxes.
 * @returns One strip per side that hides something.
 */
export function placeStrips(state: LayoutState, info: GraphInfo, rects: Map<string, Rect>): Strip[] {
	const strips: Strip[] = [];

	// a strip and the padding before it, which a strip on the next side over stops short of
	const room = STRIP_THICKNESS + PADDING;

	for (const id of state.expanded) {
		const box = rects.get(id);
		if (box === undefined) {
			continue;
		}

		const shown = arrangeShown(state, info, id);
		const hidden = { left: shown.hiddenLeft, right: shown.hiddenRight, top: shown.hiddenTop, bottom: shown.hiddenBottom };
		const leftRoom = hidden.left.length > 0 ? room : 0;
		const rightRoom = hidden.right.length > 0 ? room : 0;
		const topRoom = hidden.top.length > 0 ? room : 0;
		const bottomRoom = hidden.bottom.length > 0 ? room : 0;

		// the space strips go in: inside the padding, below the title
		const inside = { x: box.x + PADDING, y: box.y + HEADER + PADDING, width: box.width - 2 * PADDING, height: box.height - HEADER - 2 * PADDING };

		// side strips: full height between the top and bottom strips
		const sideY = inside.y + topRoom;
		const sideHeight = inside.height - topRoom - bottomRoom;
		if (leftRoom > 0) {
			strips.push({
				id: stripId(id, 'left'),
				ownerId: id,
				side: 'left',
				rect: { x: inside.x, y: sideY, width: STRIP_THICKNESS, height: sideHeight },
				hiddenIds: hidden.left,
			});
		}
		if (rightRoom > 0) {
			strips.push({
				id: stripId(id, 'right'),
				ownerId: id,
				side: 'right',
				rect: { x: inside.x + inside.width - STRIP_THICKNESS, y: sideY, width: STRIP_THICKNESS, height: sideHeight },
				hiddenIds: hidden.right,
			});
		}

		// top and bottom strips: full width between the side strips
		const acrossX = inside.x + leftRoom;
		const acrossWidth = inside.width - leftRoom - rightRoom;
		if (topRoom > 0) {
			strips.push({
				id: stripId(id, 'top'),
				ownerId: id,
				side: 'top',
				rect: { x: acrossX, y: inside.y, width: acrossWidth, height: STRIP_THICKNESS },
				hiddenIds: hidden.top,
			});
		}
		if (bottomRoom > 0) {
			strips.push({
				id: stripId(id, 'bottom'),
				ownerId: id,
				side: 'bottom',
				rect: { x: acrossX, y: inside.y + inside.height - STRIP_THICKNESS, width: acrossWidth, height: STRIP_THICKNESS },
				hiddenIds: hidden.bottom,
			});
		}
	}


	return strips;
}
