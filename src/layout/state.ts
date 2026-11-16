import { Edge, Graph, Node, ROOT_ID } from '../graph/types';
import { isInside, liftEdges } from '../analysis/edges';
import { getLineage, indexChildren, indexNodes } from '../analysis/lookups';
import { computeIndegrees, sortAllChildren } from '../analysis/metrics';
import { defaultLayout, GAP } from './defaultLayout';
import { Position, Rect, Size } from './geometry';
import { nodeSize } from './size';
import { squishHorizontally, squishVertically, tightHeight, tightWidth } from './squish';
import { addOwed, cancelPullsOntoOthers, carryAlong, chainInPath, copyPushes, forgetPushed, movedFrom, moveInPath, payOwed, Push, Pushes, takeBackPushes } from './push';

// how many children a parent shows, and how many more each click reveals
export const CHILD_LIMIT = 5;

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

// which page a directory shows, in its layout's coordinates. Columns and rows count from the anchor, so pages left of
// or above it have negative ones. Until the user resizes the directory, its pages are a grid of one size and the box
// fits its page; after, each page is cut to fit the box (fitPageToSize)
export interface Page {
	column: number;
	row: number;
	anchor: Position;
	size: Size; // the grid's page size
	natural: Size; // the page at full spacing, as it opened
	drawnFrom: Position; // where the current page is drawn from
	origins: Record<string, Position>; // where each page is drawn from, by cellKey, so a page turned back to is drawn
	// from the same spot even if the user moved its boxes
}

/**
 * Names a page, to look up where it's drawn from.
 * @param cell The page.
 * @returns Its column and row, like "1,0".
 */
function cellKey(cell: PageCell): string {
	return cell.column + ',' + cell.row;
}

/**
 * Turns a directory to one of its pages, drawn from where it was last drawn from, so boxes the user moved stay put, or
 * else from the top-left of its boxes. The page being left is remembered the same way. The box fits its page, so a
 * turn can change its size, and its neighbors make room.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The directory.
 * @param cell The page to show.
 */
function showPage(state: LayoutState, info: GraphInfo, id: string, cell: PageCell): void {
	function turn(): void {
		const page = state.pages.get(id)!;
		const origins = { ...page.origins, [cellKey(page)]: page.drawnFrom };
		const drawnFrom = origins[cellKey(cell)] ?? topLeftOfPage(state, info, id, cell, page.anchor, page.size);
		state.pages.set(id, { ...page, column: cell.column, row: cell.row, drawnFrom: drawnFrom, origins: origins });

		// a box pushed left or up since it was last shown would be drawn outside the directory
		keepPageAroundBoxes(state, info, id);
	}
	changeSize(state, info, id, turn);
}

// the four sides of a box, where its strips can be
export type StripSide = 'left' | 'right' | 'top' | 'bottom';

// everything about the view that can differ from the default; deleting an entry brings the default back
export interface LayoutState {
	expanded: Set<string>; // open nodes; the root is always open
	homes: Map<string, Position>; // each placed box's top-left, relative to the top-left of its parent's whole layout
	pages: Map<string, Page>; // each opened directory's current page and page size, the root's included
	childPages: Map<string, PageCell>; // each child's page in its directory, kept until the directory is resized or reset
	jumpOpened: Set<string>; // directories opened by jumping to a node, which the next jump closes; opening by hand keeps one
	closedSizes: Map<string, Size>; // only boxes the user has resized while closed
	openSizes: Map<string, Size>; // only boxes the user has resized while open; others fit their children
	pushes: Map<string, Pushes>; // how each box moved its siblings as it changed size, so changing back undoes it
	owed: Map<string, Position>; // how far a box still has to move back, where something open was in its way
	heldSizes: Map<string, Size>; // resized directories drawn bigger than their open size so their page fits; not saved
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
		jumpOpened: new Set(),
		closedSizes: new Map(),
		openSizes: new Map(),
		pushes: new Map(),
		owed: new Map(),
		heldSizes: new Map(),
	};
}

/**
 * Copies the state, so a change can be tried on the copy and thrown away. Positions, sizes and pushes are shared, which
 * is safe because nothing changes one in place; a new one is always set instead.
 * @param state The state to copy.
 * @returns A state with the same entries, in sets and maps of its own.
 */
export function copyLayoutState(state: LayoutState): LayoutState {
	return {
		expanded: new Set(state.expanded),
		homes: new Map(state.homes),
		pages: new Map(state.pages),
		childPages: new Map(state.childPages),
		jumpOpened: new Set(state.jumpOpened),
		closedSizes: new Map(state.closedSizes),
		openSizes: new Map(state.openSizes),
		pushes: new Map(state.pushes),
		owed: new Map(state.owed),
		heldSizes: new Map(state.heldSizes),
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
 * Finds where a directory's current page is drawn from in its layout: the top-left of the boxes on it, as it was when
 * the page was turned to or resized. Boxes on other pages can be pushed while a box grows, so a page's grid corner
 * can sit above or left of its first box; drawing from the boxes leaves no empty space before them. It stays put while
 * the page is showing, so moving a box on it never shifts the rest.
 * @param state The view state.
 * @param parentId The directory.
 * @returns The page's drawn top-left, in the layout's coordinates; (0, 0) for a directory without pages.
 */
function pageOrigin(state: LayoutState, parentId: string): Position {
	const page = state.pages.get(parentId);
	if (page === undefined) {
		return { x: 0, y: 0 };
	}
	return page.drawnFrom;
}

/**
 * Finds the top-left of the boxes on one of a directory's pages, to draw the page from.
 * @param state The view state.
 * @param info The graph lookups.
 * @param parentId The directory.
 * @param cell The page.
 * @param anchor Where its pages are cut from.
 * @param size Its page size.
 * @returns The furthest left and furthest up any box on the page starts; the page's grid corner if it has none.
 */
function topLeftOfPage(state: LayoutState, info: GraphInfo, parentId: string, cell: PageCell, anchor: Position, size: Size): Position {
	let left = Infinity;
	let top = Infinity;
	for (const id of info.childrenById.get(parentId) ?? []) {
		const home = state.homes.get(id);
		const childCell = state.childPages.get(id);
		if (home !== undefined && childCell !== undefined && childCell.column === cell.column && childCell.row === cell.row) {
			left = Math.min(left, home.x);
			top = Math.min(top, home.y);
		}
	}
	if (left === Infinity) {
		return { x: anchor.x + cell.column * size.width, y: anchor.y + cell.row * size.height };
	}
	return { x: left, y: top };
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
function shownChildren(state: LayoutState, info: GraphInfo, parentId: string): string[] {
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
		let listing = byCell.get(cellKey(cell));
		if (listing === undefined) {
			listing = { cell: cell, childIds: [], isCurrent: cellKey(cell) === cellKey(page!) };
			byCell.set(cellKey(cell), listing);
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
	if (nearest !== undefined) {
		showPage(state, info, id, nearest);
	}
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
function closedSize(state: LayoutState, info: GraphInfo, id: string): Size {
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
 * Places every placed child of a node at its home, on every page, at its current size. Making room for a growing or
 * dropped box works on these, so boxes on other pages move too, and nothing ends up on top of anything when the page
 * turns or pages are cut again.
 * @param state The view state.
 * @param info The graph lookups.
 * @param parentId The node.
 * @returns Each placed child's rect, relative to the top-left of the parent's whole layout.
 */
export function placedChildRects(state: LayoutState, info: GraphInfo, parentId: string): Map<string, Rect> {
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
		holdCurrentPage(state, info, nodeId);
		const now = boxSize(state, info, nodeId);
		moveSiblingsForSize(state, info, nodeId, before.get(nodeId)!, now);
		growResizedParent(state, info, nodeId, before.get(nodeId)!, now);
	}
	holdCurrentPage(state, info, ROOT_ID);
}

/**
 * Draws a directory the user resized big enough for its current page to fit. Only dragging its corner moves children
 * to other pages (fitPageToSize); anything else that needs more room, like opening a directory inside it, gets the
 * room instead. It's worked out again after every change and never stored as the directory's size, so it goes away
 * once nothing needs it.
 * @param state The view state. The directory's held size is set or cleared.
 * @param info The graph lookups.
 * @param id The directory.
 */
function holdCurrentPage(state: LayoutState, info: GraphInfo, id: string): void {
	state.heldSizes.delete(id);
	const set = state.openSizes.get(id);
	if (set === undefined || !state.expanded.has(id)) {
		return;
	}
	const rects = arrangeChildren(state, info, id);
	const frame = pageFrame(state, info, id);
	const width = squishHorizontally(rects, set.width - frame.width).fits ? set.width : frame.width + tightWidth(rects);

	// the height is measured on the children as they're drawn at that width: squishing across slides them, which
	// changes which ones share a column
	const across = squishHorizontally(rects, width - frame.width);
	const height = squishVertically(across.rects, set.height - frame.height).fits ? set.height : frame.height + tightHeight(across.rects);
	if (width !== set.width || height !== set.height) {
		state.heldSizes.set(id, { width: width, height: height });
	}
}

/**
 * Finds the size a resized directory is drawn at: the size the user gave it, or bigger while its page needs more room.
 * @param state The view state.
 * @param id The directory.
 * @returns Its drawn size, or undefined if the user hasn't resized it.
 */
function resizedSize(state: LayoutState, id: string): Size | undefined {
	return state.heldSizes.get(id) ?? state.openSizes.get(id);
}

/**
 * Grows a directory the user resized by as much as a box inside it grew, or shrinks it by as much, the way a directory
 * that fits its children does. The box's siblings moved by that much too, so the page still fits.
 * @param state The view state. The parent's open size may change.
 * @param info The graph lookups.
 * @param id The box that changed size.
 * @param old Its size before.
 * @param now Its size after.
 */
function growResizedParent(state: LayoutState, info: GraphInfo, id: string, old: Size, now: Size): void {
	const parentId = info.nodesById.get(id)!.parent;
	if (parentId === null || !state.homes.has(id) || !state.expanded.has(parentId)) {
		return;
	}
	const set = state.openSizes.get(parentId);
	if (set === undefined) {
		return;
	}
	const min = smallestRoom(state, info, parentId);
	state.openSizes.set(parentId, {
		width: Math.max(min.width, set.width + now.width - old.width),
		height: Math.max(min.height, set.height + now.height - old.height),
	});
}

/**
 * Moves the siblings in a box's path to make room for its new size, or takes back room it no longer needs. Changing
 * size against its latest pushes takes them back exactly, so closing undoes opening. Any change left over moves what's
 * in the way, below it in its column and beside it in its row, and is recorded so it can be taken back too.
 * @param state The view state. Siblings in the path get new homes, and the box's pushes change.
 * @param info The graph lookups.
 * @param id The box that changed size.
 * @param old Its size before.
 * @param now Its size after.
 */
function moveSiblingsForSize(state: LayoutState, info: GraphInfo, id: string, old: Size, now: Size): void {
	const home = state.homes.get(id);
	if (home === undefined || (old.width === now.width && old.height === now.height)) {
		return;
	}

	// every other placed sibling, at its home, on any page
	const siblings = new Map<string, Rect>();
	for (const [siblingId, rect] of placedChildRects(state, info, info.nodesById.get(id)!.parent!)) {
		if (siblingId !== id) {
			siblings.set(siblingId, rect);
		}
	}

	// first, the latest pushes the other way are taken back. A box whose way back is blocked, like by a box opened
	// since, stays where it is and owes the move, so closing boxes in any order still puts everything back
	const pushes = copyPushes(state.pushes.get(id));
	const undone = new Map(siblings);
	const takenAcross = takeBackPushes(pushes.right, now.width - old.width, undone, 'right');
	const takenDown = takeBackPushes(pushes.down, now.height - old.height, undone, 'down');
	const intended = new Map(undone);
	cancelPullsOntoOthers(siblings, undone);
	for (const [siblingId, rect] of intended) {
		if (rect !== siblings.get(siblingId) && undone.get(siblingId) === siblings.get(siblingId)) {
			addOwed(state.owed, siblingId, rect.x - siblings.get(siblingId)!.x, rect.y - siblings.get(siblingId)!.y);
		}
	}

	// what's left of the change makes room the usual way, from the size the taking back got to
	const from = { width: old.width + takenAcross, height: old.height + takenDown };
	const dx = now.width - from.width;
	const dy = now.height - from.height;
	const after = new Map(undone);
	if (dx !== 0 || dy !== 0) {
		// the area the box covers at its bigger size, so growing and shrinking pick the same boxes; its edges are the
		// smaller ones, since that's where the room opens or closes
		const width = Math.max(from.width, now.width);
		const height = Math.max(from.height, now.height);
		const column = { start: home.x, end: home.x + width, edge: home.y + Math.min(from.height, now.height) };
		const row = { start: home.y, end: home.y + height, edge: home.x + Math.min(from.width, now.width) };

		const below = dy !== 0 ? chainInPath(undone, column, 'down') : new Set<string>();
		const beside = dx !== 0 ? chainInPath(undone, row, 'right') : new Set<string>();
		moveInPath(undone, after, beside, below, dx, dy);

		// a box pushed both ways can land on one that wasn't in either path; that one comes along the same way
		if (dx > 0 || dy > 0) {
			carryAlong(undone, after, beside, below, dx, dy);
		}

		// pulling boxes in may land one on another; that one stays
		if (dx < 0 || dy < 0) {
			cancelPullsOntoOthers(undone, after);
		}

		// recorded even when nothing moved, so changing back takes back exactly this much before moving anything
		if (dx !== 0) {
			pushes.right.push({ amount: dx, ids: movedFrom(beside, undone, after) });
		}
		if (dy !== 0) {
			pushes.down.push({ amount: dy, ids: movedFrom(below, undone, after) });
		}
	}

	// then boxes owing a move from before make it, now that something may have moved out of their way; the box itself
	// may owe one too, from while it was bigger
	const everyBefore = new Map(siblings);
	everyBefore.set(id, { x: home.x, y: home.y, width: old.width, height: old.height });
	after.set(id, { x: home.x, y: home.y, width: now.width, height: now.height });
	payOwed(state.owed, everyBefore, after);

	state.pushes.set(id, pushes);
	for (const [boxId, rect] of after) {
		const was = state.homes.get(boxId)!;
		if (rect.x !== was.x || rect.y !== was.y) {
			state.homes.set(boxId, { x: rect.x, y: rect.y });
		}
	}
	keepPageAroundBoxes(state, info, info.nodesById.get(id)!.parent!);
}

/**
 * Makes sure a directory's current page is drawn from no further right or down than its boxes. A box on another page
 * changing size can pull boxes on this one past it, which would draw them outside the directory.
 * @param state The view state. The page's drawn top-left may move left or up.
 * @param info The graph lookups.
 * @param parentId The directory.
 */
export function keepPageAroundBoxes(state: LayoutState, info: GraphInfo, parentId: string): void {
	const page = state.pages.get(parentId);
	if (page === undefined) {
		return;
	}
	let left = page.drawnFrom.x;
	let top = page.drawnFrom.y;
	for (const childId of shownChildren(state, info, parentId)) {
		const home = state.homes.get(childId)!;
		left = Math.min(left, home.x);
		top = Math.min(top, home.y);
	}
	if (left !== page.drawnFrom.x || top !== page.drawnFrom.y) {
		state.pages.set(parentId, { ...page, drawnFrom: { x: left, y: top } });
	}
}

// what's drawn inside a box: where its shown children go, and which children wait behind each side's strip
export interface Arrangement {
	rects: Map<string, Rect>; // relative to where the box's page is drawn
	hidden: HiddenSides;
}

/**
 * Works out what a box shows: the children on its page as arranged, squished into the box if the user made it smaller
 * than they need, with children on other pages waiting behind strips.
 * @param state The view state.
 * @param info The graph lookups.
 * @param parentId The box.
 * @returns The shown children's rects, and the hidden ones on each side.
 */
export function arrangeShown(state: LayoutState, info: GraphInfo, parentId: string): Arrangement {
	const rects = arrangeChildren(state, info, parentId);
	const hidden = hiddenSides(state, info, parentId);

	// only a size the user chose can be too small; otherwise the box fits its children
	const size = resizedSize(state, parentId);
	if (size === undefined || !state.expanded.has(parentId)) {
		return { rects: rects, hidden: hidden };
	}

	// across first, then down on what that drew
	const frame = pageFrame(state, info, parentId);
	const across = squishHorizontally(rects, size.width - frame.width);
	const down = squishVertically(across.rects, size.height - frame.height);
	return { rects: down.rects, hidden: hidden };
}

/**
 * Finds how much room a box keeps for strips of children on other pages, on each side.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @returns STRIP_ROOM on each side that has some, otherwise nothing.
 */
function stripRoom(state: LayoutState, info: GraphInfo, id: string): { left: number; right: number; top: number; bottom: number } {
	const hidden = hiddenSides(state, info, id);
	return {
		left: stripRoomIf(hidden.left.length > 0),
		right: stripRoomIf(hidden.right.length > 0),
		top: stripRoomIf(hidden.top.length > 0),
		bottom: stripRoomIf(hidden.bottom.length > 0),
	};
}

/**
 * Finds how much of an open box isn't its page: the padding all around, the title, and room for its strips.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The open box.
 * @returns How much wider and taller the box is than its page.
 */
function pageFrame(state: LayoutState, info: GraphInfo, id: string): Size {
	const origin = childOrigin(state, info, id);
	const room = stripRoom(state, info, id);
	return { width: origin.x + PADDING + room.right, height: origin.y + PADDING + room.bottom };
}

/**
 * Works out how big an open box must be to hold its page: the page's size, so turning pages never resizes the box,
 * or more if a child on it sticks out past the page's edge.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The open box.
 * @returns The size reaching its page's far edges or its furthest child, plus padding and room for its name.
 */
function fitSize(state: LayoutState, info: GraphInfo, id: string): Size {
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

	const frame = pageFrame(state, info, id);
	return { width: frame.width + right, height: frame.height + bottom };
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
		return resizedSize(state, id) ?? fitSize(state, info, id);
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
 * Finds how tall a page has to be to hold CHILD_LIMIT boxes down each column, and no more: boxes in a column share
 * their left edge in the default layout.
 * @param state The view state.
 * @param info The graph lookups.
 * @param ids The boxes to measure, with homes.
 * @returns The furthest bottom of any column's CHILD_LIMIT-th box (or its last, if shorter), plus the gap after it.
 */
function columnLimitHeight(state: LayoutState, info: GraphInfo, ids: string[]): number {
	// each column's boxes, by their left edge
	const columns = new Map<number, string[]>();
	for (const id of ids) {
		const x = state.homes.get(id)!.x;
		const column = columns.get(x) ?? [];
		column.push(id);
		columns.set(x, column);
	}

	function topFirst(a: string, b: string): number {
		return state.homes.get(a)!.y - state.homes.get(b)!.y;
	}
	let height = 1;
	for (const column of columns.values()) {
		for (const id of column.sort(topFirst).slice(0, CHILD_LIMIT)) {
			height = Math.max(height, state.homes.get(id)!.y + boxSize(state, info, id).height + GAP);
		}
	}
	return height;
}

/**
 * Gives a directory its pages the first time it opens, and its children the page each is on. The first page is sized
 * to hold its CHILD_LIMIT most important children from the top-left; for the root, everything in the flow plus up to
 * CHILD_LIMIT of the rest, but no more than CHILD_LIMIT boxes down any column. A directory that already has pages keeps them, and only children new to it get a page, so
 * nothing moves to another page on its own.
 * @param state The view state. Gets the pages.
 * @param info The graph lookups.
 * @param parentId The directory.
 * @param newIds Children just given homes, which need a page.
 */
function givePages(state: LayoutState, info: GraphInfo, parentId: string, newIds: string[]): void {
	let page = state.pages.get(parentId);
	let needPages = newIds;
	const isNewPage = page === undefined;
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

		// the root's first page is as wide as its flow, but no taller than CHILD_LIMIT boxes down any column
		if (parentId === ROOT_ID) {
			height = Math.min(height, columnLimitHeight(state, info, firstPage));
		}
		const size = { width: width, height: height };
		page = { column: 0, row: 0, anchor: { x: 0, y: 0 }, size: size, natural: size, drawnFrom: { x: 0, y: 0 }, origins: {} };
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

	// a new page is drawn from its first boxes
	if (isNewPage) {
		const first = { column: 0, row: 0 };
		page.drawnFrom = topLeftOfPage(state, info, parentId, first, page.anchor, page.size);
	}

	// a directory the user resized cuts its pages to its size, so new children go on whichever page they fit
	if (state.openSizes.has(parentId) && needPages.length > 0) {
		fitPageToSize(state, info, parentId);
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
		state.heldSizes.delete(id);

			// forget everything about what's inside it, at every depth: where it goes, its size, and whether it's open
		for (const nodeId of info.nodesById.keys()) {
			if (nodeId !== id && isInside(nodeId, id, info.nodesById)) {
				const perNode: { delete(key: string): boolean }[] = [
					state.homes, state.closedSizes, state.openSizes, state.expanded, state.pages, state.childPages,
					state.jumpOpened, state.pushes, state.owed, state.heldSizes,
				];
				for (const entries of perNode) {
					entries.delete(nodeId);
				}
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
 * Moves a box to a new home within its parent. It stays on the page it's on, wherever it goes, and its siblings forget
 * pushing it, so it stays where it's put.
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

	// it's where the user put it now, so no sibling changing size moves it back to where it was pushed from
	state.owed.delete(id);
	for (const [pusherId, pushes] of state.pushes) {
		const mentioned = pushes.right.concat(pushes.down).some(function mentions(push: Push): boolean {
			return push.ids.includes(id);
		});
		if (mentioned) {
			const copy = copyPushes(pushes);
			forgetPushed(copy, id);
			state.pushes.set(pusherId, copy);
		}
	}
}

/**
 * Makes sure a box that was just dropped isn't past its directory's right or bottom edge: a directory the user resized
 * grows just enough to hold it, and its page. Directories without a size the user set fit their children anyway.
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
			// what this one box needs: up to its far edges, plus the padding, title and strips
			const frame = pageFrame(state, info, ancestorId);
			state.openSizes.set(ancestorId, {
				width: Math.max(set.width, frame.width + rect.x + rect.width),
				height: Math.max(set.height, frame.height + rect.y + rect.height),
			});
		}

		holdCurrentPage(state, info, ancestorId);
		child = ancestorId;
	}
}

// the smallest a box can be resized to: room for an arrow and a few letters, and for an open box, its title strip
const MIN_BOX_WIDTH = 60;
const MIN_BOX_HEIGHT = 28;

/**
 * Gives a box a size the user chose, moving its neighbors to make room (or take back room) as it changes.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @param size The new size. Anything smaller than the minimum is raised to it: for an open box, room for its
 *   biggest child and the strips its pages need.
 */
export function resizeTo(state: LayoutState, info: GraphInfo, id: string, size: Size): void {
	function resize(): void {
		setSize(state, info, id, size);
	}
	changeSize(state, info, id, resize);
}

/**
 * Stores a size the user chose, within the minimum.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @param size The new size.
 */
function setSize(state: LayoutState, info: GraphInfo, id: string, size: Size): void {
	// open and closed sizes are kept apart, so resizing one doesn't change the other
	if (state.expanded.has(id)) {
		const min = minOpenSize(state, info, id, size);
		state.openSizes.set(id, { width: Math.max(min.width, size.width), height: Math.max(min.height, size.height) });
		state.heldSizes.delete(id);

		// a size between the ones tried can cut differently; room for a strip on every side always fits
		if (!fitPageToSize(state, info, id)) {
			const most = roomForEveryStrip(smallestRoom(state, info, id));
			const set = state.openSizes.get(id)!;
			state.openSizes.set(id, { width: Math.max(most.width, set.width), height: Math.max(most.height, set.height) });
			fitPageToSize(state, info, id);
		}
	} else {
		state.closedSizes.set(id, { width: Math.max(MIN_BOX_WIDTH, size.width), height: Math.max(MIN_BOX_HEIGHT, size.height) });
	}
}

/**
 * Finds the smallest an open box can be resized to, for the size asked for: room for its biggest child, plus only the
 * strips its pages need at that size. Strips are all that changes how much room a page needs, so it tries room for
 * none, then one, on a copy; room for two always fits. Widths come first, since they decide which children share a
 * column.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The open box.
 * @param size The size asked for.
 * @returns The smallest width and height.
 */
function minOpenSize(state: LayoutState, info: GraphInfo, id: string, size: Size): Size {
	const least = smallestRoom(state, info, id);
	const most = roomForEveryStrip(least);
	if (size.width >= most.width && size.height >= most.height) {
		return most;
	}

	// the narrowest whose columns fit, with all the height strips could need, then the shortest at that width
	function fitsAtWidth(width: number): boolean {
		return cutsToFit(state, info, id, { width: Math.max(width, size.width), height: Math.max(most.height, size.height) });
	}
	const width = smallestThatFits(least.width, most.width, fitsAtWidth);
	function fitsAtHeight(height: number): boolean {
		return cutsToFit(state, info, id, { width: Math.max(width, size.width), height: Math.max(height, size.height) });
	}
	return { width: width, height: smallestThatFits(least.height, most.height, fitsAtHeight) };
}

/**
 * Tries room for no strips, then one; room for two always fits.
 * @param least The room with no strips.
 * @param most The room with two.
 * @param fits Whether pages cut at a size fit.
 * @returns The smallest of the three that fits.
 */
function smallestThatFits(least: number, most: number, fits: (size: number) => boolean): number {
	for (const size of [least, least + STRIP_ROOM]) {
		if (fits(size)) {
			return size;
		}
	}
	return most;
}

/**
 * Finds the room an open box needs for its biggest child and nothing else: no strips.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The open box.
 * @returns The widest child's width and the tallest child's height, plus padding and the title.
 */
function smallestRoom(state: LayoutState, info: GraphInfo, id: string): Size {
	let widest = 0;
	let tallest = 0;
	for (const childId of info.childrenById.get(id) ?? []) {
		if (state.homes.has(childId)) {
			const size = boxSize(state, info, childId);
			widest = Math.max(widest, size.width);
			tallest = Math.max(tallest, size.height);
		}
	}
	return { width: Math.max(MIN_BOX_WIDTH, PADDING + widest + PADDING), height: HEADER + PADDING + tallest + PADDING };
}

/**
 * Adds room for a strip on every side, which any page fits in, since a page holds at least one child.
 * @param least The room for the biggest child alone.
 * @returns That much bigger by two strips each way.
 */
function roomForEveryStrip(least: Size): Size {
	return { width: least.width + 2 * STRIP_ROOM, height: least.height + 2 * STRIP_ROOM };
}

/**
 * Tries cutting a directory's pages at a size, on a copy, to see whether every page would fit.
 * @param state The view state. Not changed.
 * @param info The graph lookups.
 * @param id The directory.
 * @param size The size to try.
 * @returns True if every page fits at that size.
 */
function cutsToFit(state: LayoutState, info: GraphInfo, id: string, size: Size): boolean {
	const copy = copyLayoutState(state);
	copy.openSizes.set(id, size);
	copy.heldSizes.delete(id);
	return fitPageToSize(copy, info, id);
}

/**
 * Cuts a directory's pages to fit the size the user gave it: columns of pages across, each as wide as fits, then pages
 * down each column, each as tall as fits. A page leaves room for exactly the strips it has, so every page fits and
 * turning never changes the box. The current page stays in view.
 * @param state The view state. The directory's page and its children's pages change.
 * @param info The graph lookups.
 * @param id The directory, open, with a size the user gave it.
 * @returns True if every page fits; false if the box is too small for some page even holding one child.
 */
function fitPageToSize(state: LayoutState, info: GraphInfo, id: string): boolean {
	const set = state.openSizes.get(id);
	const page = state.pages.get(id);
	if (set === undefined || page === undefined) {
		return true;
	}
	const rects = placedChildRects(state, info, id);

	// cut from the current page's top-left in a direction the user turned in, and otherwise from the layout's edge, so a
	// left or top strip only ever comes from turning right or down
	const past = hiddenSides(state, info, id);
	const kept = pageOrigin(state, id);
	const anchor = { x: past.left.length > 0 ? kept.x : Infinity, y: past.top.length > 0 ? kept.y : Infinity };
	for (const rect of rects.values()) {
		if (past.left.length === 0) {
			anchor.x = Math.min(anchor.x, rect.x);
		}
		if (past.top.length === 0) {
			anchor.y = Math.min(anchor.y, rect.y);
		}
	}
	if (rects.size === 0) {
		anchor.x = kept.x;
		anchor.y = kept.y;
	}

	// the room inside for a page with no strips
	const width = set.width - 2 * PADDING;
	const height = set.height - HEADER - 2 * PADDING;

	function xOf(childId: string): number {
		return rects.get(childId)!.x;
	}
	function yOf(childId: string): number {
		return rects.get(childId)!.y;
	}

	// the page starting at the anchor is drawn from where the current page is now, unless a box on it is further left
	// or up, so a box the user moved stays where they put it; every other page is drawn from the top-left of its boxes
	function originOf(ids: string[], atAnchor: boolean): Position {
		const corner = cornerOf(rects, ids);
		if (!atAnchor) {
			return corner;
		}
		return { x: Math.min(kept.x, corner.x), y: Math.min(kept.y, corner.y) };
	}

	// a column of pages fits if its rows squish into the width its side strips leave
	function fitsAcross(ids: string[], hasLeft: boolean, hasRight: boolean, atAnchor: boolean): boolean {
		const room = width - stripRoomIf(hasLeft) - stripRoomIf(hasRight);
		const origin = originOf(ids, atAnchor);
		return spansNoMore(ids, xOf, origin.x, page!.natural.width, room) && squishHorizontally(drawnFrom(rects, ids, origin), room).fits;
	}

	let allFit = true;
	const origins: Record<string, Position> = {};
	for (const column of cutAlong(Array.from(rects.keys()), xOf, anchor.x, fitsAcross)) {
		allFit = allFit && column.fits;
		const columnWidth = width - stripRoomIf(column.hasBefore) - stripRoomIf(column.hasAfter);

		// a page down the column fits if it squishes across, as it's drawn, and then down into the height its top and
		// bottom strips leave
		const fitsDown = function fitsDown(ids: string[], hasTop: boolean, hasBottom: boolean, atAnchor: boolean): boolean {
			const room = height - stripRoomIf(hasTop) - stripRoomIf(hasBottom);
			const origin = originOf(ids, column.atAnchor && atAnchor);
			if (!spansNoMore(ids, yOf, origin.y, page!.natural.height, room)) {
				return false;
			}
			const across = squishHorizontally(drawnFrom(rects, ids, origin), columnWidth);
			return across.fits && squishVertically(across.rects, room).fits;
		};

		for (const row of cutAlong(column.ids, yOf, anchor.y, fitsDown)) {
			allFit = allFit && row.fits;
			const cell = { column: column.index, row: row.index };
			origins[cellKey(cell)] = originOf(row.ids, column.atAnchor && row.atAnchor);
			for (const childId of row.ids) {
				state.childPages.set(childId, cell);
			}
		}
	}

	// the page starting at the anchor shows, drawn from its boxes; if it has none, like when boxes moved since it was
	// turned to, the page of the box nearest it
	let current: PageCell = { column: 0, row: 0 };
	const hasBoxes = (info.childrenById.get(id) ?? []).some(function isOnFirst(childId: string): boolean {
		const cell = state.childPages.get(childId);
		return state.homes.has(childId) && cell !== undefined && cell.column === 0 && cell.row === 0;
	});
	if (!hasBoxes) {
		current = pageNearest(state, info, id, anchor);
	}
	const shownFrom = origins[cellKey(current)] ?? topLeftOfPage(state, info, id, current, anchor, page.size);
	state.pages.set(id, { ...page, column: current.column, row: current.row, anchor: anchor, drawnFrom: shownFrom, origins: origins });
	return allFit;
}

/**
 * Checks that a page's children start no further from where it's drawn than a page holds at full spacing: the room, or
 * the default page if the room is smaller. So shrinking squishes a page before moving children off it, and never packs
 * more on at tighter gaps.
 * @param ids The page's children.
 * @param startOf Where a child starts in that direction.
 * @param origin Where the page is drawn from in that direction.
 * @param natural The default page's size in that direction.
 * @param room The room inside the box for the page in that direction.
 * @returns True if the last starts less than that far after the origin.
 */
function spansNoMore(ids: string[], startOf: (id: string) => number, origin: number, natural: number, room: number): boolean {
	let last = -Infinity;
	for (const id of ids) {
		last = Math.max(last, startOf(id));
	}
	return last - origin < Math.max(natural, room + GAP);
}

/**
 * Finds the room a strip takes inside a box, if there is one.
 * @param hasStrip Whether there's a strip on that side.
 * @returns STRIP_ROOM if there is, otherwise nothing.
 */
function stripRoomIf(hasStrip: boolean): number {
	return hasStrip ? STRIP_ROOM : 0;
}

/**
 * Finds the top-left of some boxes: the furthest left and furthest up any of them starts.
 * @param rects Every box.
 * @param ids The ones to measure.
 * @returns Their top-left.
 */
function cornerOf(rects: Map<string, Rect>, ids: string[]): Position {
	let left = Infinity;
	let top = Infinity;
	for (const id of ids) {
		left = Math.min(left, rects.get(id)!.x);
		top = Math.min(top, rects.get(id)!.y);
	}
	return { x: left, y: top };
}

/**
 * Picks out some boxes, moved so a page drawn from a spot has that spot at (0, 0), the way the page will draw them.
 * @param rects Every box.
 * @param ids The ones to pick.
 * @param origin Where the page is drawn from.
 * @returns Their rects, moved.
 */
function drawnFrom(rects: Map<string, Rect>, ids: string[], origin: Position): Map<string, Rect> {
	const moved = new Map<string, Rect>();
	for (const id of ids) {
		const rect = rects.get(id)!;
		moved.set(id, { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height });
	}
	return moved;
}

// a run of children cut along one direction, holding every child that starts in it
interface Cut {
	index: number; // 0 for the run starting at the anchor, counting up after it and down before it
	ids: string[];
	hasBefore: boolean; // some child starts before it, so it has a strip on that side
	hasAfter: boolean; // some child starts after it
	fits: boolean; // false only for a run of the children at one start that don't fit even alone
	atAnchor: boolean; // the first run forward, starting at the anchor
}

/**
 * Cuts children into runs along one direction, each as long as fits: forward from the anchor, then back from it for
 * children that start before it. A run always holds at least the children at its first start, even if they don't fit,
 * so no run is empty.
 * @param ids The children to cut.
 * @param startOf Where a child starts in that direction.
 * @param anchor Where the first run forward starts.
 * @param fits Whether a run's children fit, given whether it has a strip before and after it, and whether it's the
 *   run starting at the anchor.
 * @returns The runs.
 */
function cutAlong(ids: string[], startOf: (id: string) => number, anchor: number, fits: (run: string[], hasBefore: boolean, hasAfter: boolean, atAnchor: boolean) => boolean): Cut[] {
	// each different start, in order, with the children starting there; a run goes from one of these to another
	const atStart = new Map<number, string[]>();
	for (const id of ids) {
		atStart.set(startOf(id), (atStart.get(startOf(id)) ?? []).concat(id));
	}
	const starts = Array.from(atStart.keys()).sort(function ascending(a: number, b: number): number {
		return a - b;
	});
	const last = starts.length - 1;

	// the children starting from starts[from] through starts[to]
	function between(from: number, to: number): string[] {
		const run: string[] = [];
		for (let i = from; i <= to; i++) {
			run.push(...atStart.get(starts[i])!);
		}
		return run;
	}

	// the first start at or after the anchor; everything before it is cut backward
	let firstForward = starts.findIndex(function atOrAfter(start: number): boolean {
		return start >= anchor;
	});
	if (firstForward === -1) {
		firstForward = starts.length;
	}

	const cuts: Cut[] = [];

	// forward: each run as long as fits, longest first
	let index = 0;
	let from = firstForward;
	while (from <= last) {
		let to = from;
		const atAnchor = from === firstForward;
		for (let longest = last; longest > from; longest--) {
			if (fits(between(from, longest), from > 0, longest < last, atAnchor)) {
				to = longest;
				break;
			}
		}
		const fitsHere = to > from || fits(between(from, to), from > 0, to < last, atAnchor);
		cuts.push({ index: index, ids: between(from, to), hasBefore: from > 0, hasAfter: to < last, fits: fitsHere, atAnchor: atAnchor });
		index++;
		from = to + 1;
	}

	// backward: each run ending just before the last one cut, starting as early as fits
	index = -1;
	let to = firstForward - 1;
	while (to >= 0) {
		let start = to;
		for (let earliest = 0; earliest < to; earliest++) {
			if (fits(between(earliest, to), earliest > 0, true, false)) {
				start = earliest;
				break;
			}
		}
		const fitsHere = start < to || fits(between(start, to), start > 0, true, false);
		cuts.push({ index: index, ids: between(start, to), hasBefore: start > 0, hasAfter: true, fits: fitsHere, atAnchor: false });
		index--;
		to = start - 1;
	}
	return cuts;
}

/**
 * Finds the page of the child nearest a spot, to show after pages are cut: normally the page starting there.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The directory.
 * @param spot A spot in its layout.
 * @returns The page, or the first one if it has no children.
 */
function pageNearest(state: LayoutState, info: GraphInfo, id: string, spot: Position): PageCell {
	let nearest: PageCell = { column: 0, row: 0 };
	let nearestDistance = Infinity;
	for (const childId of info.childrenById.get(id) ?? []) {
		const home = state.homes.get(childId);
		const cell = state.childPages.get(childId);
		if (home !== undefined && cell !== undefined) {
			const distance = Math.hypot(home.x - spot.x, home.y - spot.y);
			if (distance < nearestDistance) {
				nearest = cell;
				nearestDistance = distance;
			}
		}
	}
	return nearest;
}

/**
 * Makes room for every resized directory's current page after loading a layout, since held sizes aren't saved. Deepest
 * first, since a directory's room depends on its children's.
 * @param state The view state. Held sizes are set.
 * @param info The graph lookups.
 */
export function holdPages(state: LayoutState, info: GraphInfo): void {
	for (const id of deepestFirst(info, Array.from(state.expanded))) {
		holdCurrentPage(state, info, id);
	}
}

/**
 * Sorts nodes deepest first: a lineage runs from the node up to the root, so a longer one is deeper.
 * @param info The graph lookups.
 * @param ids The nodes.
 * @returns A sorted copy.
 */
function deepestFirst(info: GraphInfo, ids: string[]): string[] {
	return ids.toSorted(function deeperFirst(a: string, b: string): number {
		return getLineage(b, info.nodesById).length - getLineage(a, info.nodesById).length;
	});
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
	// the lineage runs from the node up to the root
	const lineage = getLineage(id, info.nodesById);

	// what earlier jumps opened closes again, so jumping around doesn't crowd the graph
	closeEarlierJumps(state, info, new Set(lineage));

	// from the root down, each directory then the one inside it
	for (let i = lineage.length - 1; i >= 1; i--) {
		const parentId = lineage[i];
		if (!state.expanded.has(parentId)) {
			openNode(state, info, parentId);
			state.jumpOpened.add(parentId);
		}
		const cell = state.childPages.get(lineage[i - 1]);
		if (cell !== undefined) {
			turnToPage(state, info, parentId, cell);
		}
	}
}

/**
 * Closes the directories earlier jumps opened, deepest first, so the boxes around each move back as it closes. Ones on
 * the way to the node being jumped to stay open, and so do ones holding a directory the user opened, so that one
 * doesn't vanish inside a closed box.
 * @param state The view state.
 * @param info The graph lookups.
 * @param keep The node being jumped to and every directory around it.
 */
function closeEarlierJumps(state: LayoutState, info: GraphInfo, keep: Set<string>): void {
	const toClose: string[] = [];
	for (const id of state.jumpOpened) {
		if (keep.has(id)) {
			continue;
		}

		// a directory the user opened inside it keeps it open
		let holdsUsers = false;
		for (const openId of state.expanded) {
			if (openId !== id && !state.jumpOpened.has(openId) && isInside(openId, id, info.nodesById)) {
				holdsUsers = true;
			}
		}
		if (!holdsUsers) {
			toClose.push(id);
		}
	}

	for (const id of deepestFirst(info, toClose)) {
		closeNode(state, info, id);
		state.jumpOpened.delete(id);
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
	if (page !== undefined && cellKey(cell) !== cellKey(page)) {
		showPage(state, info, id, cell);
	}
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
