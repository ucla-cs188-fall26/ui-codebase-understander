import { Edge, Graph, Node, ROOT_ID } from '../graph/types';
import { isInside, liftEdges } from '../analysis/edges';
import { getLineage, indexChildren, indexNodes } from '../analysis/lookups';
import { computeIndegrees, sortAllChildren } from '../analysis/metrics';
import { defaultLayout, GAP } from './defaultLayout';
import { Position, Rect, Size } from './geometry';
import { nodeSize } from './size';
import { CHILD_LIMIT } from './visibility';
import { minSquishHeight, minSquishWidth, squishHorizontally, squishVertically } from './squish';

// lookups about the graph, built once per graph and shared by everything that lays it out
export interface GraphInfo {
	nodesById: Map<string, Node>;
	childrenById: Map<string, string[]>; // most important first
	indegrees: Map<string, number>;
	edges: Edge[];
	topLevelShown: string[]; // the top-level nodes that get a box, most important first
}

// a page's place in a directory's layout: how many pages across and down it is from the top-left one
export interface PageCell {
	column: number;
	row: number;
}

// which page a directory shows, and how big its pages are, in its layout's coordinates. Pages are cut from an anchor:
// the layout's top-left at first, and the current page's top-left after a resize, so resizing keeps the same part of
// the layout in view. Columns and rows count from the anchor, so pages left of or above it have negative ones
export interface Page {
	column: number;
	row: number;
	anchor: Position;
	size: Size; // the page as it is now; smaller than natural while the box is too small to squish its page into
	natural: Size; // the page at full spacing: what it opened at, or bigger once the user made the box bigger
}

// the four sides of a box, where its strips can be
export type StripSide = 'left' | 'right' | 'top' | 'bottom';

// everything about the view that can differ from the default; deleting an entry brings the default back
export interface LayoutState {
	expanded: Set<string>; // open nodes; the root is always open
	homes: Map<string, Position>; // each placed box's top-left, relative to the top-left of its parent's whole layout
	pages: Map<string, Page>; // each opened directory's current page and page size, the root's included
	childPages: Map<string, PageCell>; // each child's page in its directory, kept until the directory is resized or reset
	closedSizes: Map<string, Size>; // only boxes the user has resized while closed
	openSizes: Map<string, Size>; // only boxes the user has resized while open; others fit their children
}

/**
 * Builds the lookups everything else shares. Call this once per graph.
 * @param graph The graph from the extension.
 * @returns The nodes by id, each node's children sorted most important first, every indegree, the edges, and which
 *   top-level nodes get a box.
 */
export function buildGraphInfo(graph: Graph): GraphInfo {
	const nodesById = indexNodes(graph.nodes);
	const indegrees = computeIndegrees(nodesById, graph.edges);
	const childrenById = sortAllChildren(indexChildren(graph.nodes), nodesById, indegrees);
	const topLevelShown = chooseTopLevel(childrenById.get(ROOT_ID) ?? [], graph.edges, nodesById);
	return {
		nodesById: nodesById,
		childrenById: childrenById,
		indegrees: indegrees,
		edges: graph.edges,
		topLevelShown: topLevelShown,
	};
}

/**
 * Picks which top-level nodes get a box: everything part of the flow, since that's the structure of the code, and
 * only a few of the rest, like config files and docs, which would otherwise crowd it out.
 * @param children The top-level nodes, most important first.
 * @param edges Every edge in the graph.
 * @param nodesById Every node in the graph, by id.
 * @returns Every top-level node with an arrow in or out, and the first CHILD_LIMIT without, in importance order.
 */
function chooseTopLevel(children: string[], edges: Edge[], nodesById: Map<string, Node>): string[] {
	const inFlow = topLevelInFlow(edges, nodesById);

	const shown: string[] = [];
	let others = 0;
	for (const id of children) {
		if (inFlow.has(id)) {
			shown.push(id);
		} else if (others < CHILD_LIMIT) {
			shown.push(id);
			others++;
		}
	}
	return shown;
}

/**
 * Finds the top-level nodes that are part of the flow: at either end of an edge between top-level nodes, counting
 * edges from anything inside them.
 * @param edges Every edge in the graph.
 * @param nodesById Every node in the graph, by id.
 * @returns Their ids.
 */
function topLevelInFlow(edges: Edge[], nodesById: Map<string, Node>): Set<string> {
	const inFlow = new Set<string>();
	for (const edge of liftEdges(ROOT_ID, edges, nodesById)) {
		inFlow.add(edge.from);
		inFlow.add(edge.to);
	}
	return inFlow;
}

// space between an open box's edge and its children, and room at its top for its name, in pixels
export const PADDING = 20;
export const HEADER = 32;

// how thick a "+N" strip is, and the room one takes inside a box: the strip plus the padding between it and the
// children, so the padding is even all around
export const STRIP_THICKNESS = 16;
const STRIP_ROOM = STRIP_THICKNESS + PADDING;

/**
 * Finds where an open box's page is drawn from, inside the box: past the padding and the title, and past a strip on the
 * left or top if it has one.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The open box.
 * @returns The offset from the box's top-left to where its page's (0, 0) is drawn.
 */
export function childOrigin(state: LayoutState, info: GraphInfo, id: string): Position {
	const room = stripRoom(state, info, id);
	return { x: PADDING + room.left, y: HEADER + PADDING + room.top };
}

/**
 * Makes the state for a graph nobody has arranged yet.
 * @returns A state with only the root open and nothing placed.
 */
export function createLayoutState(): LayoutState {
	return {
		expanded: new Set([ROOT_ID]),
		homes: new Map(),
		pages: new Map(),
		childPages: new Map(),
		closedSizes: new Map(),
		openSizes: new Map(),
	};
}

/**
 * Copies the state, so a change can be tried on the copy and thrown away. Positions and sizes are shared, which is
 * safe because nothing changes one in place; a new one is always set instead.
 * @param state The state to copy.
 * @returns A state with the same entries, in sets and maps of its own.
 */
export function copyLayoutState(state: LayoutState): LayoutState {
	return {
		expanded: new Set(state.expanded),
		homes: new Map(state.homes),
		pages: new Map(state.pages),
		childPages: new Map(state.childPages),
		closedSizes: new Map(state.closedSizes),
		openSizes: new Map(state.openSizes),
	};
}


/**
 * Finds which page a spot in a directory's layout is on: the one holding it.
 * @param position A spot in the layout, like a box's home.
 * @param anchor Where the pages are cut from.
 * @param size The directory's page size.
 * @returns How many pages across and down it is from the anchor.
 */
function cellOf(position: Position, anchor: Position, size: Size): PageCell {
	return {
		column: Math.floor((position.x - anchor.x) / size.width),
		row: Math.floor((position.y - anchor.y) / size.height),
	};
}

/**
 * Finds where a directory's current page starts in its layout.
 * @param state The view state.
 * @param parentId The directory.
 * @returns The page's top-left, in the layout's coordinates; (0, 0) for a directory without pages.
 */
export function pageOrigin(state: LayoutState, parentId: string): Position {
	const page = state.pages.get(parentId);
	if (page === undefined) {
		return { x: 0, y: 0 };
	}
	return { x: page.anchor.x + page.column * page.size.width, y: page.anchor.y + page.row * page.size.height };
}

/**
 * Checks whether a child is on its directory's current page. A child without a saved page counts as on it, like a
 * box placed by hand.
 * @param state The view state.
 * @param parentId The directory.
 * @param id The child.
 * @returns True if it's shown on the page now.
 */
function isOnPage(state: LayoutState, parentId: string, id: string): boolean {
	const page = state.pages.get(parentId);
	const cell = state.childPages.get(id);
	if (page === undefined || cell === undefined) {
		return true;
	}
	return cell.column === page.column && cell.row === page.row;
}

/**
 * Lists the children of a node that get their own box: the placed ones on its current page.
 * @param state The view state.
 * @param info The graph lookups.
 * @param parentId The node whose children we want.
 * @returns The shown children, most important first.
 */
export function shownChildren(state: LayoutState, info: GraphInfo, parentId: string): string[] {
	const shown: string[] = [];
	for (const id of info.childrenById.get(parentId) ?? []) {
		if (state.homes.has(id) && isOnPage(state, parentId, id)) {
			shown.push(id);
		}
	}
	return shown;
}

// the children hidden on each side of a box, behind that side's strip
export interface HiddenSides {
	left: string[];
	right: string[];
	top: string[];
	bottom: string[];
}

/**
 * Sorts a node's hidden children by the side their page is on: a page in another column goes left or right, and one
 * in the same column goes up or down.
 * @param state The view state.
 * @param info The graph lookups.
 * @param parentId The node.
 * @returns The hidden children on each side, most important first.
 */
export function hiddenSides(state: LayoutState, info: GraphInfo, parentId: string): HiddenSides {
	const sides: HiddenSides = { left: [], right: [], top: [], bottom: [] };
	const page = state.pages.get(parentId);
	if (page === undefined) {
		return sides;
	}
	for (const id of info.childrenById.get(parentId) ?? []) {
		const cell = state.childPages.get(id);
		if (cell === undefined || isOnPage(state, parentId, id)) {
			continue;
		}
		if (cell.column < page.column) {
			sides.left.push(id);
		} else if (cell.column > page.column) {
			sides.right.push(id);
		} else if (cell.row < page.row) {
			sides.top.push(id);
		} else {
			sides.bottom.push(id);
		}
	}
	return sides;
}

// one of a directory's pages that has children on it, for listing them
export interface PageListing {
	cell: PageCell;
	childIds: string[]; // the children on it, most important first
	isCurrent: boolean;
}

/**
 * Lists a directory's pages that have children on them, in reading order: top to bottom, and left to right within a
 * row of pages. Empty pages are left out, the same as turning skips them, except the current page, which is always
 * listed so it has a place.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The directory.
 * @returns Its pages, or nothing if it has no pages.
 */
export function listPages(state: LayoutState, info: GraphInfo, id: string): PageListing[] {
	const page = state.pages.get(id);
	if (page === undefined) {
		return [];
	}

	// one listing per page, found by its column and row
	const byCell = new Map<string, PageListing>();
	function listingFor(cell: PageCell): PageListing {
		const key = cell.column + ',' + cell.row;
		let listing = byCell.get(key);
		if (listing === undefined) {
			listing = { cell: cell, childIds: [], isCurrent: cell.column === page!.column && cell.row === page!.row };
			byCell.set(key, listing);
		}
		return listing;
	}

	listingFor({ column: page.column, row: page.row });
	for (const childId of info.childrenById.get(id) ?? []) {
		const cell = state.childPages.get(childId);
		if (cell !== undefined) {
			listingFor(cell).childIds.push(childId);
		}
	}

	function readingOrder(a: PageListing, b: PageListing): number {
		if (a.cell.row !== b.cell.row) {
			return a.cell.row - b.cell.row;
		}
		return a.cell.column - b.cell.column;
	}
	return Array.from(byCell.values()).sort(readingOrder);
}

/**
 * Turns a directory to the next page on one side, the way clicking that side's strip does: the nearest page that way
 * with children on it, so a turn never lands on an empty page. Only the page changes: no home moves, and no child
 * changes page.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The directory.
 * @param side Which strip was clicked.
 */
export function turnPage(state: LayoutState, info: GraphInfo, id: string, side: StripSide): void {
	const page = state.pages.get(id);
	if (page === undefined) {
		return;
	}

	// the hidden child on that side whose page is nearest: fewest pages away that way first, then fewest the other way
	let nearest: PageCell | undefined = undefined;
	let nearestAlong = Infinity;
	let nearestAcross = Infinity;
	for (const childId of hiddenSides(state, info, id)[side]) {
		const cell = state.childPages.get(childId)!;
		let along = Math.abs(cell.row - page.row);
		let across = Math.abs(cell.column - page.column);
		if (side === 'left' || side === 'right') {
			along = Math.abs(cell.column - page.column);
			across = Math.abs(cell.row - page.row);
		}
		if (along < nearestAlong || (along === nearestAlong && across < nearestAcross)) {
			nearest = cell;
			nearestAlong = along;
			nearestAcross = across;
		}
	}
	if (nearest === undefined) {
		return;
	}

	// the box fits its page, so a page with bigger or more boxes changes its size, and its neighbors make room
	const target = nearest;
	function turn(): void {
		state.pages.set(id, { column: target.column, row: target.row, anchor: page!.anchor, size: page!.size, natural: page!.natural });
	}
	changeSize(state, info, id, turn);
}

/**
 * Finds a box's size from its importance alone, ignoring anything the user did. Homes are laid out for this size.
 * @param info The graph lookups.
 * @param id The box.
 * @returns Its default closed size.
 */
export function defaultSize(info: GraphInfo, id: string): Size {
	const node = info.nodesById.get(id)!;
	return nodeSize(node.childCount, info.indegrees.get(id)!);
}

/**
 * Finds how big a box is while closed.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @returns The size the user gave it, or its default size.
 */
export function closedSize(state: LayoutState, info: GraphInfo, id: string): Size {
	return state.closedSizes.get(id) ?? defaultSize(info, id);
}

/**
 * Places a node's shown children at their homes, at their current sizes, measured from its current page. Room for
 * boxes that grew was already made when they grew (changeSize), so a home is exactly where a box is drawn.
 * @param state The view state.
 * @param info The graph lookups.
 * @param parentId The node whose children to arrange.
 * @returns Each placed child's rect, relative to the top-left of the parent's current page, in flow order.
 */
export function arrangeChildren(state: LayoutState, info: GraphInfo, parentId: string): Map<string, Rect> {
	const childIds: string[] = [];
	for (const id of shownChildren(state, info, parentId)) {
		if (state.homes.has(id)) {
			childIds.push(id);
		}
	}
	const origin = pageOrigin(state, parentId);

	// flow order, left to right then top to bottom, which is also the order to paint them
	function compareFlow(a: string, b: string): number {
		const homeA = state.homes.get(a)!;
		const homeB = state.homes.get(b)!;
		if (homeA.x !== homeB.x) {
			return homeA.x - homeB.x;
		}
		return homeA.y - homeB.y;
	}

	const arranged = new Map<string, Rect>();
	for (const id of childIds.toSorted(compareFlow)) {
		const home = state.homes.get(id)!;
		const size = boxSize(state, info, id);
		arranged.set(id, { x: home.x - origin.x, y: home.y - origin.y, width: size.width, height: size.height });
	}
	return arranged;
}

/**
 * Places every placed child of a node at its home, on every page, at its current size. Making room for a growing box
 * works on these, so boxes on other pages move too, and nothing ends up on top of anything when the page turns.
 * @param state The view state.
 * @param info The graph lookups.
 * @param parentId The node.
 * @returns Each placed child's rect, relative to the top-left of the parent's whole layout.
 */
function placedChildRects(state: LayoutState, info: GraphInfo, parentId: string): Map<string, Rect> {
	const rects = new Map<string, Rect>();
	for (const id of info.childrenById.get(parentId) ?? []) {
		const home = state.homes.get(id);
		if (home !== undefined) {
			const size = boxSize(state, info, id);
			rects.set(id, { x: home.x, y: home.y, width: size.width, height: size.height });
		}
	}
	return rects;
}

/**
 * Makes a change that may resize boxes, then makes room for it, once: at every level from the box up, siblings past a
 * resized box's old right edge move right by however much wider it got, and those past its old bottom edge move down
 * by however much taller. A box getting smaller moves them back by the same amount, so shrinking reverses growing.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box being changed; the boxes around it may change size too, like a directory fitting a child.
 * @param change The change itself, like opening, closing, or resizing the box.
 */
export function changeSize(state: LayoutState, info: GraphInfo, id: string, change: () => void): void {
	// the box and everything around it, up to (not including) the root, which has no siblings to move
	const lineage = getLineage(id, info.nodesById).slice(0, -1);
	const before = new Map<string, Size>();
	for (const nodeId of lineage) {
		before.set(nodeId, boxSize(state, info, nodeId));
	}

	change();

	// from the box up: making room inside a directory can change that directory's size in turn
	for (const nodeId of lineage) {
		moveSiblingsForSize(state, info, nodeId, before.get(nodeId)!, boxSize(state, info, nodeId));
	}
}

/**
 * Moves the siblings in a box's path to make room for its new size, or to take back room it no longer needs. Only
 * what's in the way moves: below it in its column, beside it in its row, and whatever those would run into in turn.
 * @param state The view state. Siblings in the path get new homes.
 * @param info The graph lookups.
 * @param id The box that changed size.
 * @param old Its size before.
 * @param now Its size after.
 */
function moveSiblingsForSize(state: LayoutState, info: GraphInfo, id: string, old: Size, now: Size): void {
	const home = state.homes.get(id);
	const dx = now.width - old.width;
	const dy = now.height - old.height;
	if (home === undefined || (dx === 0 && dy === 0)) {
		return;
	}

	// every other placed sibling, at its home, on any page
	const siblings = new Map<string, Rect>();
	for (const [siblingId, rect] of placedChildRects(state, info, info.nodesById.get(id)!.parent!)) {
		if (siblingId !== id) {
			siblings.set(siblingId, rect);
		}
	}

	// the area the box covers at its bigger size, so growing and shrinking pick the same boxes; its edges are the old
	// ones, since that's where the room opens or closes
	const width = Math.max(old.width, now.width);
	const height = Math.max(old.height, now.height);
	const column = { start: home.x, end: home.x + width, edge: home.y + old.height };
	const row = { start: home.y, end: home.y + height, edge: home.x + old.width };

	const below = dy !== 0 ? chainInPath(siblings, column, 'down') : new Set<string>();
	const beside = dx !== 0 ? chainInPath(siblings, row, 'right') : new Set<string>();
	for (const siblingId of siblings.keys()) {
		const sibling = state.homes.get(siblingId)!;
		state.homes.set(siblingId, {
			x: beside.has(siblingId) ? sibling.x + dx : sibling.x,
			y: below.has(siblingId) ? sibling.y + dy : sibling.y,
		});
	}
}

/**
 * Finds the boxes in a growing box's path in one direction: those past its edge that share its column (going down) or
 * row (going right), then those past them in theirs, since a moved box would run into them.
 * @param siblings The boxes that might be in the way, where they're drawn.
 * @param path The growing box's range across the direction (start to end) and its edge along it.
 * @param direction 'down' for a column, 'right' for a row.
 * @returns The ids of every box that has to move.
 */
function chainInPath(siblings: Map<string, Rect>, path: { start: number; end: number; edge: number }, direction: 'down' | 'right'): Set<string> {
	// each box as its range across the direction, and where it starts and ends along it
	function across(rect: Rect): { start: number; end: number } {
		return direction === 'down' ? { start: rect.x, end: rect.x + rect.width } : { start: rect.y, end: rect.y + rect.height };
	}
	function along(rect: Rect): { start: number; end: number } {
		return direction === 'down' ? { start: rect.y, end: rect.y + rect.height } : { start: rect.x, end: rect.x + rect.width };
	}

	const found = new Set<string>();

	// the growing box first, then each box found, each looking past its own far edge within its own range
	const toCheck = [{ start: path.start, end: path.end, edge: path.edge }];
	while (toCheck.length > 0) {
		const current = toCheck.pop()!;
		for (const [siblingId, rect] of siblings) {
			const range = across(rect);
			const shares = range.start < current.end && current.start < range.end;
			if (!found.has(siblingId) && shares && along(rect).start >= current.edge) {
				found.add(siblingId);
				toCheck.push({ start: range.start, end: range.end, edge: along(rect).end });
			}
		}
	}
	return found;
}

/**
 * Squishes a box's children sideways into its width, the first of arrangeShown's two squishes. A side with a strip
 * gives it room; if squishing only finds out it must hide something there, it tries again with the room set aside.
 * @param rects The children as arranged.
 * @param insideWidth The room inside the box, from its left padding to its right padding.
 * @param hasRightStrip True if children past the limit already wait on the right.
 * @returns The squished children, and the ones it hid.
 */
function squishAcross(rects: Map<string, Rect>, insideWidth: number, hasRightStrip: boolean): { rects: Map<string, Rect>; hidden: string[]; fits: boolean } {
	let across = squishHorizontally(rects, insideWidth - (hasRightStrip ? STRIP_ROOM : 0));
	if (across.hidden.length > 0 && !hasRightStrip) {
		across = squishHorizontally(rects, insideWidth - STRIP_ROOM);
	}
	return across;
}

// what's drawn inside a box: where its shown children go, and which children wait behind each side's strip
export interface Arrangement {
	rects: Map<string, Rect>; // relative to where the box's page is drawn
	hiddenLeft: string[];
	hiddenRight: string[]; // in flow order
	hiddenTop: string[];
	hiddenBottom: string[];
}

/**
 * Works out what a box shows: the children on its page as arranged, squished into the box if the user made it smaller
 * than they need, with children on other pages and any the squish hid waiting behind strips.
 * @param state The view state.
 * @param info The graph lookups.
 * @param parentId The box.
 * @returns The shown children's rects, and the hidden ones on each side.
 */
export function arrangeShown(state: LayoutState, info: GraphInfo, parentId: string): Arrangement {
	const rects = arrangeChildren(state, info, parentId);

	// children on other pages wait on the side their page is on
	const past = hiddenSides(state, info, parentId);

	// only a size the user chose can be too small; otherwise the box fits its children
	const set = state.openSizes.get(parentId);
	if (set === undefined || !state.expanded.has(parentId)) {
		return { rects: rects, hiddenLeft: past.left, hiddenRight: past.right, hiddenTop: past.top, hiddenBottom: past.bottom };
	}

	// the inside: within the padding on every side and below the title, measured from where children start
	const origin = childOrigin(state, info, parentId);
	const insideWidth = set.width - origin.x - PADDING;
	const insideHeight = set.height - origin.y - PADDING;

	// a side with a strip gives it room; if squishing only finds out it must hide something there, it tries again with
	// the room set aside
	const across = squishAcross(rects, insideWidth, past.right.length > 0);
	let down = squishVertically(across.rects, insideHeight - (past.bottom.length > 0 ? STRIP_ROOM : 0));
	if (down.hidden.length > 0 && past.bottom.length === 0) {
		down = squishVertically(across.rects, insideHeight - STRIP_ROOM);
	}

	return {
		rects: down.rects,
		hiddenLeft: past.left,
		hiddenRight: across.hidden.concat(past.right),
		hiddenTop: past.top,
		hiddenBottom: down.hidden.concat(past.bottom),
	};
}

/**
 * Finds how much room a box keeps for strips of children on other pages, on each side.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @returns STRIP_ROOM on each side that has some, otherwise nothing.
 */
function stripRoom(state: LayoutState, info: GraphInfo, id: string): { left: number; right: number; top: number; bottom: number } {
	const past = hiddenSides(state, info, id);
	function roomFor(hidden: string[]): number {
		return hidden.length > 0 ? STRIP_ROOM : 0;
	}
	return { left: roomFor(past.left), right: roomFor(past.right), top: roomFor(past.top), bottom: roomFor(past.bottom) };
}

/**
 * Works out how big an open box must be to hold its page: the page's size, so turning pages never resizes the box,
 * or more if a child on it sticks out past the page's edge.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The open box.
 * @returns The size reaching its page's far edges or its furthest child, plus padding and room for its name.
 */
export function fitSize(state: LayoutState, info: GraphInfo, id: string): Size {
	let right = 0;
	let bottom = 0;
	const page = state.pages.get(id);
	if (page !== undefined) {
		// a page includes the gap after its last boxes, which the box doesn't need to show
		right = page.size.width - GAP;
		bottom = page.size.height - GAP;
	}

	// arranged rects use current sizes and include pushes: opening a child grows its parent
	for (const rect of arrangeChildren(state, info, id).values()) {
		right = Math.max(right, rect.x + rect.width);
		bottom = Math.max(bottom, rect.y + rect.height);
	}

	// plus room for strips of children on other pages, so their padding is even too
	const origin = childOrigin(state, info, id);
	const room = stripRoom(state, info, id);
	return { width: origin.x + right + PADDING + room.right, height: origin.y + bottom + PADDING + room.bottom };
}

/**
 * Finds how big a box is right now.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @returns If open: the size the user gave it, or a size that fits its children. If closed: its closed size.
 */
export function boxSize(state: LayoutState, info: GraphInfo, id: string): Size {
	if (state.expanded.has(id)) {
		return state.openSizes.get(id) ?? fitSize(state, info, id);
	}
	return closedSize(state, info, id);
}

/**
 * Gives a node's children their homes from the default layout, the first time it opens: every child, shown or not, so
 * each has its own home on some page. At the top level, the ones in the flow are laid out first and the rest (configs,
 * docs) below them, so the flow fills the first page. The node then gets its pages, and each child the page it's on.
 * @param state The view state. Gets the new homes, and pages.
 * @param info The graph lookups.
 * @param parentId The node being opened.
 */
export function layOutChildren(state: LayoutState, info: GraphInfo, parentId: string): void {
	// placed before: keep what's there, so reopening never rearranges anything; only children without a home are laid
	// out, like new files
	const placed: string[] = [];
	const unplaced: string[] = [];
	for (const id of info.childrenById.get(parentId) ?? []) {
		if (state.homes.has(id)) {
			placed.push(id);
		} else {
			unplaced.push(id);
		}
	}

	// at the top level, the flow first, then the rest below everything placed so far
	let firstBatch = unplaced;
	let secondBatch: string[] = [];
	if (parentId === ROOT_ID) {
		const inFlow = topLevelInFlow(info.edges, info.nodesById);
		firstBatch = [];
		for (const id of unplaced) {
			if (inFlow.has(id)) {
				firstBatch.push(id);
			} else {
				secondBatch.push(id);
			}
		}
	}
	if (firstBatch.length > 0) {
		placeUnplaced(state, info, parentId, placed, firstBatch);
	}
	if (secondBatch.length > 0) {
		placeUnplaced(state, info, parentId, placed.concat(firstBatch), secondBatch);
	}

	givePages(state, info, parentId, unplaced);
}

/**
 * Lays out children that have no home yet, with the default layout among themselves, below any placed ones.
 * @param state The view state. Gets the new homes.
 * @param info The graph lookups.
 * @param parentId Their parent.
 * @param placed The siblings that already have homes.
 * @param unplaced The children to lay out.
 */
function placeUnplaced(state: LayoutState, info: GraphInfo, parentId: string, placed: string[], unplaced: string[]): void {

	// only edges between the children being laid out, so nothing else can push them rightward
	const laidOut = new Set(unplaced);
	const edges: Edge[] = [];
	for (const edge of liftEdges(parentId, info.edges, info.nodesById)) {
		if (laidOut.has(edge.from) && laidOut.has(edge.to)) {
			edges.push(edge);
		}
	}

	// at their current sizes; children being laid out are closed, so that's normally their default size
	const sizes = new Map<string, Size>();
	for (const id of unplaced) {
		sizes.set(id, boxSize(state, info, id));
	}
	const positions = defaultLayout(unplaced, edges, sizes);

	// when some are already placed, the new ones go below all of them (as big as they are now), so nothing placed has
	// to move
	let left = 0;
	let top = 0;
	if (placed.length > 0) {
		left = Infinity;
		top = -Infinity;
		for (const id of placed) {
			const home = state.homes.get(id)!;
			left = Math.min(left, home.x);
			top = Math.max(top, home.y + boxSize(state, info, id).height + GAP);
		}
	}

	for (const [id, position] of positions) {
		state.homes.set(id, { x: left + position.x, y: top + position.y });
	}
}

/**
 * Gives a directory its pages the first time it opens, and its children the page each is on. The first page is sized
 * to hold its CHILD_LIMIT most important children from the top-left; for the root, everything in the flow plus up to
 * CHILD_LIMIT of the rest. A directory that already has pages keeps them, and only children new to it get a page, so
 * nothing moves to another page on its own.
 * @param state The view state. Gets the pages.
 * @param info The graph lookups.
 * @param parentId The directory.
 * @param newIds Children just given homes, which need a page.
 */
function givePages(state: LayoutState, info: GraphInfo, parentId: string, newIds: string[]): void {
	let page = state.pages.get(parentId);
	let needPages = newIds;
	if (page === undefined) {
		// top-level boxes could once go above or left of everything; a page can't, so they all move over by the same
		// amount to start at the corner, keeping their places relative to each other
		if (parentId === ROOT_ID) {
			moveIntoCorner(state, info);
		}
		let firstPage = (info.childrenById.get(parentId) ?? []).slice(0, CHILD_LIMIT);
		if (parentId === ROOT_ID) {
			firstPage = info.topLevelShown;
		}

		// from the top-left out to the far edges of its most important children, plus the gap after them, so the next
		// page starts right where its first box does; never 0, so pages can be counted
		let width = 1;
		let height = 1;
		for (const id of firstPage) {
			const home = state.homes.get(id)!;
			const size = boxSize(state, info, id);
			width = Math.max(width, home.x + size.width + GAP);
			height = Math.max(height, home.y + size.height + GAP);
		}
		const size = { width: width, height: height };
		page = { column: 0, row: 0, anchor: { x: 0, y: 0 }, size: size, natural: size };
		state.pages.set(parentId, page);

		// new pages, so every child is placed on one
		needPages = info.childrenById.get(parentId) ?? [];
	}

	for (const id of needPages) {
		const home = state.homes.get(id);
		if (home !== undefined) {
			state.childPages.set(id, cellOf(home, page.anchor, page.size));
		}
	}
}

/**
 * Moves every top-level box over by the same amount, so none is above or left of the root's top-left corner. Their
 * places relative to each other don't change.
 * @param state The view state. Top-level homes may move.
 * @param info The graph lookups.
 */
function moveIntoCorner(state: LayoutState, info: GraphInfo): void {
	let left = 0;
	let top = 0;
	for (const id of info.childrenById.get(ROOT_ID) ?? []) {
		const home = state.homes.get(id);
		if (home !== undefined) {
			left = Math.min(left, home.x);
			top = Math.min(top, home.y);
		}
	}
	if (left === 0 && top === 0) {
		return;
	}
	for (const id of info.childrenById.get(ROOT_ID) ?? []) {
		const home = state.homes.get(id);
		if (home !== undefined) {
			state.homes.set(id, { x: home.x - left, y: home.y - top });
		}
	}
}

/**
 * Puts a box and everything inside it back to how it first looked: the default layout and sizes, with every box
 * inside it closed. The box itself stays open or closed. Resetting the root resets the whole graph.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box to reset.
 */
export function resetNode(state: LayoutState, info: GraphInfo, id: string): void {
	// its size changes, so its siblings move to match, the same as any resize
	function reset(): void {
		state.closedSizes.delete(id);
		state.openSizes.delete(id);

		// forget everything about what's inside it, at every depth: where it goes, its size, and whether it's open
		for (const nodeId of info.nodesById.keys()) {
			if (nodeId !== id && isInside(nodeId, id, info.nodesById)) {
				state.homes.delete(nodeId);
				state.closedSizes.delete(nodeId);
				state.openSizes.delete(nodeId);
				state.expanded.delete(nodeId);
				state.pages.delete(nodeId);
				state.childPages.delete(nodeId);
			}
		}

		// its pages start over from the default layout too
		state.pages.delete(id);

		// if the box is open, its children have no homes now, so they get the default layout again
		if (state.expanded.has(id)) {
			layOutChildren(state, info, id);
		}
	}

	if (id === ROOT_ID) {
		reset();
	} else {
		changeSize(state, info, id, reset);
	}
}

/**
 * Moves a box to a new home within its parent. It stays on the page it's on, wherever it goes.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @param position Where it should be drawn, relative to the top-left of its parent's current page. Past the parent's
 *   right or bottom edge is fine, since the parent grows to fit; past its left or top edge stops at the edge, since
 *   those never move.
 */
export function moveTo(state: LayoutState, info: GraphInfo, id: string, position: Position): void {
	const parentId = info.nodesById.get(id)!.parent!;
	const origin = pageOrigin(state, parentId);
	state.homes.set(id, { x: origin.x + Math.max(0, position.x), y: origin.y + Math.max(0, position.y) });
}

/**
 * Makes sure a box that was just dropped isn't past its directory's right or bottom edge. Only that box counts, so a
 * directory the user squished stays squished when a box is dropped inside it; it grows just enough to hold a box
 * dropped past its edge. Directories without a size the user set fit their children anyway and need nothing.
 * @param state The view state. Too-small open sizes are raised.
 * @param info The graph lookups.
 * @param id The box that was dropped.
 */
export function growToFit(state: LayoutState, info: GraphInfo, id: string): void {
	// from the box's directory up: a directory growing can stick out of its own directory in turn
	let child = id;
	for (const ancestorId of getLineage(id, info.nodesById).slice(1)) {
		const set = state.openSizes.get(ancestorId);
		const rect = arrangeChildren(state, info, ancestorId).get(child);
		if (set !== undefined && rect !== undefined) {
			// what this one box needs: up to its far edges, plus the padding (and the title, going down)
			const origin = childOrigin(state, info, ancestorId);
			const room = stripRoom(state, info, ancestorId);
			state.openSizes.set(ancestorId, {
				width: Math.max(set.width, origin.x + rect.x + rect.width + PADDING + room.right),
				height: Math.max(set.height, origin.y + rect.y + rect.height + PADDING + room.bottom),
			});
		}
		child = ancestorId;
	}
}

// the smallest a box can be resized to: room for an arrow and a few letters, and for an open box, its title strip
export const MIN_BOX_WIDTH = 60;
export const MIN_BOX_HEIGHT = 28;

/**
 * Gives a box a size the user chose, moving its neighbors to make room (or take back room) as it changes.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @param size The new size. Anything smaller than the minimum is raised to it: for an open box, the size at which
 *   every row and column of its children still shows at least 3 boxes.
 */
export function resizeTo(state: LayoutState, info: GraphInfo, id: string, size: Size): void {
	function resize(): void {
		setSize(state, info, id, size);
	}
	changeSize(state, info, id, resize);
}

/**
 * Stores a size the user chose, within the minimum, and grows the directories around it if it now sticks out.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @param size The new size.
 */
function setSize(state: LayoutState, info: GraphInfo, id: string, size: Size): void {
	const isOpen = state.expanded.has(id);

	let minWidth = MIN_BOX_WIDTH;
	let minHeight = MIN_BOX_HEIGHT;
	if (isOpen) {
		const children = arrangeChildren(state, info, id);
		const origin = childOrigin(state, info, id);
		const room = stripRoom(state, info, id);

		// at the smallest size, a row or column longer than 3 hides boxes, which brings a strip that needs its room
		const smallestWidth = minSquishWidth(children);
		const hidesAcross = squishHorizontally(children, smallestWidth).hidden.length > 0;
		const rightRoom = room.right > 0 || hidesAcross ? STRIP_ROOM : 0;
		minWidth = Math.max(minWidth, origin.x + smallestWidth + PADDING + rightRoom);

		// the height is measured on the children as they're drawn at the width it will have: squishing across slides
		// them, which changes which ones share a column
		const width = Math.max(minWidth, size.width);
		const across = squishAcross(children, width - origin.x - PADDING, room.right > 0);
		const smallestHeight = minSquishHeight(across.rects);
		const hidesDown = squishVertically(across.rects, smallestHeight).hidden.length > 0;
		const bottomRoom = room.bottom > 0 || hidesDown ? STRIP_ROOM : 0;
		minHeight = Math.max(HEADER, origin.y + smallestHeight + PADDING + bottomRoom);
	}
	const clamped = { width: Math.max(minWidth, size.width), height: Math.max(minHeight, size.height) };

	// open and closed sizes are kept apart, so resizing one doesn't change the other
	if (isOpen) {
		state.openSizes.set(id, clamped);
		fitPageToSize(state, info, id);
	} else {
		state.closedSizes.set(id, clamped);
	}

	// a box that grew past its directory's edge makes the directory grow, the same as a drop
	growToFit(state, info, id);
}

/**
 * Fits a directory's page to the size the user gave it: bigger shows more, as the page widens to fill the box; smaller
 * first squishes the page, and once it can't, the page gets smaller and the children that no longer fit move to the
 * next page. The page's top-left stays where it is, and every child's page is worked out again from there. Growing
 * reverses shrinking exactly, since the page depends only on the box's size, up to its natural size.
 * @param state The view state. The directory's page and its children's pages change.
 * @param info The graph lookups.
 * @param id The directory, open, with a size the user gave it.
 */
function fitPageToSize(state: LayoutState, info: GraphInfo, id: string): void {
	const set = state.openSizes.get(id);
	if (set === undefined || !state.pages.has(id)) {
		return;
	}
	const anchor = pageOrigin(state, id);

	// a strip can come or go as children change pages, which changes the room inside, so this settles over a few rounds
	for (let round = 0; round < 3; round++) {
		const page = state.pages.get(id)!;
		const origin = childOrigin(state, info, id);
		const room = stripRoom(state, info, id);
		const inside = { width: set.width - origin.x - PADDING - room.right, height: set.height - origin.y - PADDING - room.bottom };

		// a page includes the gap after its last boxes, which the inside doesn't need to show
		const natural = { width: Math.max(page.natural.width, inside.width + GAP), height: Math.max(page.natural.height, inside.height + GAP) };
		let width = natural.width;
		if (inside.width + GAP < natural.width) {
			width = largestFittingPage(state, info, id, anchor, 'across', inside, natural.width, natural.height);
		}
		let height = natural.height;
		if (inside.height + GAP < natural.height) {
			height = largestFittingPage(state, info, id, anchor, 'down', inside, width, natural.height);
		}

		const size = { width: width, height: height };
		state.pages.set(id, { column: 0, row: 0, anchor: anchor, size: size, natural: natural });
		let changed = false;
		for (const childId of info.childrenById.get(id) ?? []) {
			const home = state.homes.get(childId);
			if (home !== undefined) {
				const cell = cellOf(home, anchor, size);
				const old = state.childPages.get(childId);
				if (old === undefined || old.column !== cell.column || old.row !== cell.row) {
					changed = true;
				}
				state.childPages.set(childId, cell);
			}
		}
		if (!changed) {
			return;
		}
	}
}

/**
 * Fits every open directory's page to the size the user gave it, as resizing does. A layout saved before pages
 * followed sizes may show a page too big for its box, which would squish boxes off it; this moves them to the next page
 * instead.
 * @param state The view state. Pages may change.
 * @param info The graph lookups.
 */
export function fitPagesToSizes(state: LayoutState, info: GraphInfo): void {
	for (const id of state.expanded) {
		fitPageToSize(state, info, id);
	}
}

/**
 * Finds the biggest a page can be in one direction and still squish into the box: the children whose homes fall in a
 * window that big, from the anchor, fit inside at their smallest gaps. Only the spots where a child's home starts can
 * change what's in the window, so only those are tried, biggest first.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The directory.
 * @param anchor The page's top-left, which stays put.
 * @param direction 'across' to find the width, 'down' to find the height.
 * @param inside The room inside the box for its page.
 * @param width The window's width: the most to try across, or the width already found, going down.
 * @param height The window's height: the most to try down, or the full height, going across.
 * @returns The page's size in that direction.
 */
function largestFittingPage(state: LayoutState, info: GraphInfo, id: string, anchor: Position, direction: 'across' | 'down', inside: Size, width: number, height: number): number {
	// the children in a window of the given size, measured from the anchor
	function childrenWithin(windowWidth: number, windowHeight: number): Map<string, Rect> {
		const rects = new Map<string, Rect>();
		for (const childId of info.childrenById.get(id) ?? []) {
			const home = state.homes.get(childId);
			if (home === undefined) {
				continue;
			}
			const x = home.x - anchor.x;
			const y = home.y - anchor.y;
			if (x >= 0 && x < windowWidth && y >= 0 && y < windowHeight) {
				const size = boxSize(state, info, childId);
				rects.set(childId, { x: x, y: y, width: size.width, height: size.height });
			}
		}
		return rects;
	}

	// whether a window's children squish into the box without hiding any: across first, then down on what that drew,
	// as arrangeShown does. A squish that only fits by hiding boxes doesn't count, since only pages hide boxes
	function fits(windowWidth: number, windowHeight: number): boolean {
		const across = squishHorizontally(childrenWithin(windowWidth, windowHeight), inside.width);
		if (!across.fits || across.hidden.length > 0) {
			return false;
		}
		if (direction === 'across') {
			return true;
		}
		const down = squishVertically(across.rects, inside.height);
		return down.fits && down.hidden.length === 0;
	}

	// the most, then every spot where a child starts, biggest first; a window ending at a child's start leaves it out
	const most = direction === 'across' ? width : height;
	const tries = [most];
	for (const rect of childrenWithin(width, height).values()) {
		const start = direction === 'across' ? rect.x : rect.y;
		if (start > 0 && start < most) {
			tries.push(start);
		}
	}
	tries.sort(function biggestFirst(a: number, b: number): number {
		return b - a;
	});

	for (const size of tries) {
		const fitsHere = direction === 'across' ? fits(size, height) : fits(width, size);
		if (fitsHere) {
			return size;
		}
	}
	return tries[tries.length - 1];
}

/**
 * Opens a box to show its children. The first time, they get the default layout.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box to open.
 */
export function openNode(state: LayoutState, info: GraphInfo, id: string): void {
	// opening makes it bigger, so its neighbors move to make room
	function open(): void {
		state.expanded.add(id);
		layOutChildren(state, info, id);
	}
	changeSize(state, info, id, open);
}

/**
 * Shows a node: opens every directory holding it, from the top down, and turns each to the page the next one down is
 * on, so the node has a box in view. It's on its page, but not necessarily in the page's middle.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The node to show.
 */
export function showNode(state: LayoutState, info: GraphInfo, id: string): void {
	// the lineage runs from the node up to the root; go from the root down, each directory then the one inside it
	const lineage = getLineage(id, info.nodesById);
	for (let i = lineage.length - 1; i >= 1; i--) {
		const parentId = lineage[i];
		if (!state.expanded.has(parentId)) {
			openNode(state, info, parentId);
		}
		const cell = state.childPages.get(lineage[i - 1]);
		if (cell !== undefined) {
			turnToPage(state, info, parentId, cell);
		}
	}
}

/**
 * Turns a directory straight to one of its pages, like picking it from the list of pages, if it isn't there already.
 * Like any page turn, only the page changes.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The directory.
 * @param cell The page to show.
 */
export function turnToPage(state: LayoutState, info: GraphInfo, id: string, cell: PageCell): void {
	const page = state.pages.get(id);
	if (page === undefined || (cell.column === page.column && cell.row === page.row)) {
		return;
	}
	function turn(): void {
		state.pages.set(id, { column: cell.column, row: cell.row, anchor: page!.anchor, size: page!.size, natural: page!.natural });
	}
	changeSize(state, info, id, turn);
}

/**
 * Closes a box. Its neighbors move back by however much smaller it got, and its children keep their homes, so
 * reopening it shows them exactly as before.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box to close. The root can't be closed, since it is the page.
 */
export function closeNode(state: LayoutState, info: GraphInfo, id: string): void {
	if (id === ROOT_ID) {
		return;
	}
	function close(): void {
		state.expanded.delete(id);
	}
	changeSize(state, info, id, close);
}
