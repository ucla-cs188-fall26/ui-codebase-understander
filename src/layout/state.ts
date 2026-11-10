import { Edge, Graph, Node, ROOT_ID } from '../graph/types';
import { liftEdges } from '../analysis/edges';
import { indexChildren, indexNodes } from '../analysis/lookups';
import { computeIndegrees, sortAllChildren } from '../analysis/metrics';
import { defaultLayout } from './defaultLayout';
import { Position, Rect, Size } from './geometry';
import { nodeSize } from './size';
import { CHILD_LIMIT } from './visibility';

// lookups about the graph, built once per graph and shared by everything that lays it out
export interface GraphInfo {
	nodesById: Map<string, Node>;
	childrenById: Map<string, string[]>; // most important first
	indegrees: Map<string, number>;
	edges: Edge[];
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
 * @returns The nodes by id, each node's children sorted most important first, every indegree, and the edges.
 */
export function buildGraphInfo(graph: Graph): GraphInfo {
	const nodesById = indexNodes(graph.nodes);
	const indegrees = computeIndegrees(nodesById, graph.edges);
	const childrenById = sortAllChildren(indexChildren(graph.nodes), nodesById, indegrees);
	return { nodesById: nodesById, childrenById: childrenById, indegrees: indegrees, edges: graph.edges };
}

// space between an open box's edge and its children, and room at its top for its name, in pixels
const PADDING = 20;
const HEADER = 32;

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
 * Lists the children of a node that get their own box; the rest go behind "+N more".
 * @param info The graph lookups.
 * @param parentId The node whose children we want.
 * @returns Up to CHILD_LIMIT children, most important first.
 */
export function shownChildren(info: GraphInfo, parentId: string): string[] {
	const children = info.childrenById.get(parentId) ?? [];
	return children.slice(0, CHILD_LIMIT);
}

/**
 * Finds how big a box is while closed.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box.
 * @returns The size the user gave it, or the default size from its importance.
 */
export function closedSize(state: LayoutState, info: GraphInfo, id: string): Size {
	const resized = state.closedSizes.get(id);
	if (resized !== undefined) {
		return resized;
	}

	const node = info.nodesById.get(id)!;
	return nodeSize(node.childCount, info.indegrees.get(id)!);
}

/**
 * Places a node's shown children at their homes, opening up space wherever a child has grown past its closed size:
 * like inserting rows and columns, everything past a grown box's edges shifts by how much it grew.
 * Homes are left alone, so when a box shrinks back, everything returns home.
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

	// how far each child moves right and down to make room
	const shiftX = new Map<string, number>();
	const shiftY = new Map<string, number>();
	for (const id of childIds) {
		shiftX.set(id, 0);
		shiftY.set(id, 0);
	}

	for (const grownId of childIds) {
		// homes were laid out for closed sizes, so growth is measured from there
		const closed = closedSize(state, info, grownId);
		const current = boxSize(state, info, grownId);
		const growX = Math.max(0, current.width - closed.width);
		const growY = Math.max(0, current.height - closed.height);
		if (growX === 0 && growY === 0) {
			continue;
		}

		// everything past the grown box's original right edge moves right, past its bottom edge moves down
		const home = state.homes.get(grownId)!;
		const rightEdge = home.x + closed.width;
		const bottomEdge = home.y + closed.height;
		for (const id of childIds) {
			const otherHome = state.homes.get(id)!;
			if (otherHome.x >= rightEdge) {
				shiftX.set(id, shiftX.get(id)! + growX);
			}
			if (otherHome.y >= bottomEdge) {
				shiftY.set(id, shiftY.get(id)! + growY);
			}
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
		arranged.set(id, { x: home.x + shiftX.get(id)!, y: home.y + shiftY.get(id)!, width: size.width, height: size.height });
	}

	return arranged;
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

	const origin = childOrigin();
	return { width: origin.x + right + PADDING, height: origin.y + bottom + PADDING };
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
	const childIds = shownChildren(info, parentId);

	// placed before: keep what's there, so reopening never rearranges anything
	let allPlaced = true;
	for (const id of childIds) {
		if (!state.homes.has(id)) {
			allPlaced = false;
		}
	}
	if (allPlaced) {
		return;
	}

	// only edges between shown children, so a hidden child can't push a shown one rightward
	const shown = new Set(childIds);
	const edges: Edge[] = [];
	for (const edge of liftEdges(parentId, info.edges, info.nodesById)) {
		if (shown.has(edge.from) && shown.has(edge.to)) {
			edges.push(edge);
		}
	}

	const sizes = new Map<string, Size>();
	for (const id of childIds) {
		sizes.set(id, boxSize(state, info, id));
	}

	const positions = defaultLayout(childIds, edges, sizes);
	for (const [id, position] of positions) {
		state.homes.set(id, position);
	}
}

/**
 * Opens a box to show its children. The first time, they get the default layout.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The box to open.
 */
export function openNode(state: LayoutState, info: GraphInfo, id: string): void {
	state.expanded.add(id);
	layOutChildren(state, info, id);
}

/**
 * Closes a box. Its children keep their homes, so reopening it shows them exactly as before.
 * @param state The view state.
 * @param id The box to close. The root can't be closed, since it is the page.
 */
export function closeNode(state: LayoutState, id: string): void {
	if (id === ROOT_ID) {
		return;
	}
	state.expanded.delete(id);
}
