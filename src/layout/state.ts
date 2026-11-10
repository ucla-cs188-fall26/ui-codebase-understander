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

// everything about the view that can differ from the default; deleting an entry brings the default back
export interface LayoutState {
	expanded: Set<string>; // open nodes; the root is always open
	homes: Map<string, Position>; // each placed box's top-left, relative to the inside of its parent
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
	// part of the flow: at either end of an edge between top-level nodes, counting edges from anything inside them
	const inFlow = new Set<string>();
	for (const edge of liftEdges(ROOT_ID, edges, nodesById)) {
		inFlow.add(edge.from);
		inFlow.add(edge.to);
	}

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

// space between an open box's edge and its children, and room at its top for its name, in pixels
const PADDING = 20;
const HEADER = 32;

// how thick a "+N" strip is, and the room one takes inside a box: the strip plus the padding between it and the
// children, so the padding is even all around
export const STRIP_THICKNESS = 16;
const STRIP_ROOM = STRIP_THICKNESS + PADDING;

/**
 * Finds where an open box's children are measured from, inside the box.
 * @returns The offset from the box's top-left to its children's (0, 0).
 */
export function childOrigin(): Position {
	return { x: PADDING, y: HEADER + PADDING };
}

/**
 * Makes the state for a graph nobody has arranged yet.
 * @returns A state with only the root open and nothing placed.
 */
export function createLayoutState(): LayoutState {
	return {
		expanded: new Set([ROOT_ID]),
		homes: new Map(),
		closedSizes: new Map(),
		openSizes: new Map(),
	};
}

/**
 * Lists the children of a node that get their own box; the rest wait behind a strip.
 * @param info The graph lookups.
 * @param parentId The node whose children we want.
 * @returns Up to CHILD_LIMIT children, most important first; at the top level, everything part of the flow plus up to
 *   CHILD_LIMIT of the rest (chosen once per graph, in buildGraphInfo).
 */
export function shownChildren(info: GraphInfo, parentId: string): string[] {
	if (parentId === ROOT_ID) {
		return info.topLevelShown;
	}
	const children = info.childrenById.get(parentId) ?? [];
	return children.slice(0, CHILD_LIMIT);
}

/**
 * Lists the children of a node that don't get a box, whatever the box's size: the ones past the limit.
 * @param info The graph lookups.
 * @param parentId The node whose children we want.
 * @returns Its other children, most important first.
 */
function childrenPastLimit(info: GraphInfo, parentId: string): string[] {
	const shown = new Set(shownChildren(info, parentId));
	const past: string[] = [];
	for (const id of info.childrenById.get(parentId) ?? []) {
		if (!shown.has(id)) {
			past.push(id);
		}
	}
	return past;
}

// which side each directory's children past the limit wait on; it depends only on the graph, so it's worked out once
// per graph and directory. A WeakMap lets an old graph's entries be forgotten along with the graph
const pastLimitSidesCache = new WeakMap<GraphInfo, Map<string, { right: string[]; bottom: string[] }>>();

/**
 * Sorts a node's children past the limit by the side the default layout would have put them on: right of the shown
 * children goes in the right strip, anything else (in a shown column) goes in the bottom strip. At the top level they
 * all wait below.
 * @param info The graph lookups.
 * @param parentId The node.
 * @returns The hidden children on each side, most important first.
 */
export function pastLimitSides(info: GraphInfo, parentId: string): { right: string[]; bottom: string[] } {
	let byParent = pastLimitSidesCache.get(info);
	if (byParent === undefined) {
		byParent = new Map();
		pastLimitSidesCache.set(info, byParent);
	}
	const known = byParent.get(parentId);
	if (known !== undefined) {
		return known;
	}

	const past = childrenPastLimit(info, parentId);
	const sides = { right: [] as string[], bottom: [] as string[] };
	if (parentId === ROOT_ID) {
		sides.bottom = past;
	} else if (past.length > 0) {
		// where every child would go if all of them had boxes
		const all = info.childrenById.get(parentId) ?? [];
		const sizes = new Map<string, Size>();
		for (const id of all) {
			sizes.set(id, defaultSize(info, id));
		}
		const positions = defaultLayout(all, liftEdges(parentId, info.edges, info.nodesById), sizes);

		// the right edge of the shown children; anything starting past it would have been to their right
		let shownRight = 0;
		for (const id of shownChildren(info, parentId)) {
			shownRight = Math.max(shownRight, positions.get(id)!.x + sizes.get(id)!.width);
		}
		for (const id of past) {
			if (positions.get(id)!.x >= shownRight) {
				sides.right.push(id);
			} else {
				sides.bottom.push(id);
			}
		}
	}

	byParent.set(parentId, sides);
	return sides;
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
 * Places a node's shown children at their homes, at their current sizes. Room for boxes that grew was already made
 * when they grew (changeSize), so a home is exactly where a box is drawn.
 * @param state The view state.
 * @param info The graph lookups.
 * @param parentId The node whose children to arrange.
 * @returns Each placed child's rect, relative to the inside of the parent, in flow order.
 */
export function arrangeChildren(state: LayoutState, info: GraphInfo, parentId: string): Map<string, Rect> {
	const childIds: string[] = [];
	for (const id of shownChildren(info, parentId)) {
		if (state.homes.has(id)) {
			childIds.push(id);
		}
	}

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
		arranged.set(id, { x: home.x, y: home.y, width: size.width, height: size.height });
	}
	return arranged;
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
	// the box and everything around it, up to (not including) the root, which has no size
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

	// every other placed sibling, where it's drawn
	const siblings = new Map<string, Rect>();
	for (const [siblingId, rect] of arrangeChildren(state, info, info.nodesById.get(id)!.parent!)) {
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

// what's drawn inside a box: where its shown children go, and which children wait behind each side's strip
export interface Arrangement {
	rects: Map<string, Rect>; // relative to the inside of the box
	hiddenRight: string[]; // in flow order
	hiddenBottom: string[];
}

/**
 * Works out what a box shows: its children as arranged, squished into the box if the user made it smaller than they
 * need, with children past CHILD_LIMIT and any the squish hid waiting behind strips.
 * @param state The view state.
 * @param info The graph lookups.
 * @param parentId The box.
 * @returns The shown children's rects, and the hidden ones on each side.
 */
export function arrangeShown(state: LayoutState, info: GraphInfo, parentId: string): Arrangement {
	const rects = arrangeChildren(state, info, parentId);

	// children past the limit never got a home; they wait on the side the default layout would have put them
	const past = pastLimitSides(info, parentId);

	// only a size the user chose can be too small; otherwise the box fits its children
	const set = state.openSizes.get(parentId);
	if (parentId === ROOT_ID || set === undefined || !state.expanded.has(parentId)) {
		return { rects: rects, hiddenRight: past.right, hiddenBottom: past.bottom };
	}

	// the inside: within the padding on every side and below the title, measured from where children start
	const origin = childOrigin();
	const insideWidth = set.width - origin.x - PADDING;
	const insideHeight = set.height - origin.y - PADDING;

	// a side with a strip gives it room; if squishing only finds out it must hide something there, it tries again with
	// the room set aside
	let across = squishHorizontally(rects, insideWidth - (past.right.length > 0 ? STRIP_ROOM : 0));
	if (across.hidden.length > 0 && past.right.length === 0) {
		across = squishHorizontally(rects, insideWidth - STRIP_ROOM);
	}
	let down = squishVertically(across.rects, insideHeight - (past.bottom.length > 0 ? STRIP_ROOM : 0));
	if (down.hidden.length > 0 && past.bottom.length === 0) {
		down = squishVertically(across.rects, insideHeight - STRIP_ROOM);
	}

	return {
		rects: down.rects,
		hiddenRight: across.hidden.concat(past.right),
		hiddenBottom: down.hidden.concat(past.bottom),
	};
}

/**
 * Finds how much room a box keeps for strips of children past the limit, on each side.
 * @param info The graph lookups.
 * @param id The box.
 * @returns STRIP_ROOM on each side that has some, otherwise nothing. The top level keeps its own strip below the boxes
 *   instead, outside any box.
 */
function pastLimitRoom(info: GraphInfo, id: string): { right: number; bottom: number } {
	if (id === ROOT_ID) {
		return { right: 0, bottom: 0 };
	}
	const past = pastLimitSides(info, id);
	return { right: past.right.length > 0 ? STRIP_ROOM : 0, bottom: past.bottom.length > 0 ? STRIP_ROOM : 0 };
}

/**
 * Works out how big an open box must be to hold its children.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The open box.
 * @returns The size reaching its furthest child, plus padding and room for its name.
 */
export function fitSize(state: LayoutState, info: GraphInfo, id: string): Size {
	let right = 0;
	let bottom = 0;

	// arranged rects use current sizes and include pushes: opening a child grows its parent
	for (const rect of arrangeChildren(state, info, id).values()) {
		right = Math.max(right, rect.x + rect.width);
		bottom = Math.max(bottom, rect.y + rect.height);
	}

	// plus room for strips of children past the limit, so their padding is even too
	const origin = childOrigin();
	const room = pastLimitRoom(info, id);
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
 * Gives a node's shown children their homes from the default layout, the first time it opens.
 * @param state The view state. Gets the new homes.
 * @param info The graph lookups.
 * @param parentId The node being opened.
 */
export function layOutChildren(state: LayoutState, info: GraphInfo, parentId: string): void {
	// placed before: keep what's there, so reopening never rearranges anything; only children without a home are laid
	// out, like new files, or top-level files that used to be hidden
	const placed: string[] = [];
	const unplaced: string[] = [];
	for (const id of shownChildren(info, parentId)) {
		if (state.homes.has(id)) {
			placed.push(id);
		} else {
			unplaced.push(id);
		}
	}
	if (unplaced.length === 0) {
		return;
	}

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
			}
		}

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
 * Moves a box to a new home within its parent.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @param home Where it should go, relative to the inside of its parent. Past the parent's right or bottom edge is
 *   fine, since the parent grows to fit; past its left or top edge stops at the edge, since those never move.
 *   The root is the whole page and has no edges, so its children can go anywhere.
 */
export function moveTo(state: LayoutState, info: GraphInfo, id: string, home: Position): void {
	if (info.nodesById.get(id)!.parent === ROOT_ID) {
		state.homes.set(id, home);
		return;
	}
	state.homes.set(id, { x: Math.max(0, home.x), y: Math.max(0, home.y) });
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
	const origin = childOrigin();

	// from the box's directory up: a directory growing can stick out of its own directory in turn
	let child = id;
	for (const ancestorId of getLineage(id, info.nodesById).slice(1)) {
		const set = state.openSizes.get(ancestorId);
		const rect = arrangeChildren(state, info, ancestorId).get(child);
		if (set !== undefined && rect !== undefined) {
			// what this one box needs: up to its far edges, plus the padding (and the title, going down)
			const room = pastLimitRoom(info, ancestorId);
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
		const origin = childOrigin();
		const smallestWidth = minSquishWidth(children);
		const smallestHeight = minSquishHeight(children);

		// at the smallest size, a row or column longer than 3 hides boxes, which brings a strip that needs its room
		const hidesAcross = squishHorizontally(children, smallestWidth).hidden.length > 0;
		const hidesDown = squishVertically(children, smallestHeight).hidden.length > 0;
		const room = pastLimitRoom(info, id);
		const rightRoom = room.right > 0 || hidesAcross ? STRIP_ROOM : 0;
		const bottomRoom = room.bottom > 0 || hidesDown ? STRIP_ROOM : 0;

		minWidth = Math.max(minWidth, origin.x + smallestWidth + PADDING + rightRoom);
		minHeight = Math.max(HEADER, origin.y + smallestHeight + PADDING + bottomRoom);
	}
	const clamped = { width: Math.max(minWidth, size.width), height: Math.max(minHeight, size.height) };

	// open and closed sizes are kept apart, so resizing one doesn't change the other
	if (isOpen) {
		state.openSizes.set(id, clamped);
	} else {
		state.closedSizes.set(id, clamped);
	}

	// a box that grew past its directory's edge makes the directory grow, the same as a drop
	growToFit(state, info, id);
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
