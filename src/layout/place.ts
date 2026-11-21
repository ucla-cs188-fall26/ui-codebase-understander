import { Edge, EdgeKind, ROOT_ID } from '../graph/types';
import { getLineage } from '../analysis/lookups';
import { isInside } from '../analysis/edges';
import { overlapsWithGap, Position, Rect } from './geometry';
import { arrangeShown, boxSize, childOrigin, GraphInfo, HEADER, hiddenSides, LayoutState, PADDING, roomForStrips, STRIP_THICKNESS, StripSide } from './state';

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
 * @param area Where the arrow is; boxes that don't overlap it are left out, since the arrow can't pass under them.
 *   Leave it out to check every box.
 * @returns The ids of the boxes it passes under.
 */
export function boxesUnderArrow(edge: Edge, info: GraphInfo, rects: Map<string, Rect>, area?: Rect): string[] {
    // its ends, and every box around them; a strip end counts as its box
    const holding = new Set<string>();
    for (const end of [edge.from, edge.to]) {
        for (const id of getLineage(nodeOfEnd(end), info.nodesById)) {
            holding.add(id);
        }
    }

    // the outermost of the rest: boxes whose parent holds an end (the root holds everything). Only those parents'
    // children can count, so they're the only boxes checked, rather than every box on screen
    const under: string[] = [];
    for (const holderId of holding) {
        for (const id of info.childrenById.get(holderId) ?? []) {
            const rect = rects.get(id);
            if (rect === undefined || holding.has(id)) {
                continue;
            }
            if (area !== undefined && !overlapsWithGap(rect, area, 0)) {
                continue;
            }
            under.push(id);
        }
    }
    return under;
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
 * Finds what edges' ends attach to on screen, remembering what it's worked out, so the many edges that start or end in
 * the same boxes cost almost nothing after the first. Only good for one drawing, since it's built from that drawing's
 * boxes and strips.
 * @param state The view state.
 * @param info The graph lookups.
 * @param rects Every visible box, from placeBoxes.
 * @param strips Every strip, from placeStrips.
 * @param kept Boxes whose arrows aren't merged into the folders around them: an end inside one is lifted no higher
 *   than it.
 * @returns A function giving an edge's two ends (each a box's or strip's id), grouped so neither is more than maxDepth
 *   levels below the folder the edge lives in (Infinity for no limit), or undefined if either can't be shown at all.
 */
function makeArrowEndFinder(state: LayoutState, info: GraphInfo, rects: Map<string, Rect>, strips: Strip[], kept: string[]): (edge: Edge, maxDepth: number) => { from: string; to: string } | undefined {
    // which strip hides each hidden child; a child has one parent, so it's behind one strip at most
    const stripOfChild = new Map<string, string>();
    for (const strip of strips) {
        for (const id of strip.hiddenIds) {
            stripOfChild.set(id, strip.id);
        }
    }

    // each node's depth, where the root is 0 and top-level nodes are 1, worked out from its parent's
    const depths = new Map<string, number>();
    function depthOf(id: string): number {
        const known = depths.get(id);
        if (known !== undefined) {
            return known;
        }
        const parentId = info.nodesById.get(id)!.parent;
        const depth = parentId === null ? 0 : depthOf(parentId) + 1;
        depths.set(id, depth);
        return depth;
    }

    // a node's ancestor at a depth no deeper than its own, by climbing from it
    function ancestorAt(id: string, depth: number): string {
        let currentId = id;
        while (depthOf(currentId) > depth) {
            currentId = info.nodesById.get(currentId)!.parent!;
        }
        return currentId;
    }

    // what each node attaches to: its deepest visible box, or, when that box is open (so the node is hidden inside it),
    // the strip hiding the box's child that holds it; undefined when there's no such strip
    const endpoints = new Map<string, string | undefined>();
    function endpointOf(id: string): string | undefined {
        if (endpoints.has(id)) {
            return endpoints.get(id);
        }
        let box: string | undefined = undefined;
        for (const ancestorId of getLineage(id, info.nodesById)) {
            if (rects.has(ancestorId)) {
                box = ancestorId;
                break;
            }
        }
        // not even its top-level box is shown, so it's behind the root's strip, if any
        const owner = box === undefined ? ROOT_ID : box;
        let endpoint: string | undefined = box;
        if (box === undefined || state.expanded.has(box)) {
            endpoint = depthOf(id) > depthOf(owner) ? stripOfChild.get(ancestorAt(id, depthOf(owner) + 1)) : undefined;
        }
        endpoints.set(id, endpoint);
        return endpoint;
    }

    // how deep an end is; a strip counts as one level inside its box, since it stands for that box's children
    function endDepth(end: string): number {
        const nodeId = nodeOfEnd(end);
        return end === nodeId ? depthOf(nodeId) : depthOf(nodeId) + 1;
    }

    // an end moved up to its folder at a depth, when it's deeper
    function endAtDepth(end: string, depth: number): string {
        if (endDepth(end) <= depth) {
            return end;
        }
        return ancestorAt(nodeOfEnd(end), depth);
    }

    // the deepest kept box holding an end, if any: the end is lifted no higher than it
    function keptDepth(end: string): number {
        let deepest = 0;
        for (const id of kept) {
            if (isInside(nodeOfEnd(end), id, info.nodesById)) {
                deepest = Math.max(deepest, depthOf(id));
            }
        }
        return deepest;
    }

    return function arrowEnds(edge: Edge, maxDepth: number): { from: string; to: string } | undefined {
        const from = endpointOf(edge.from);
        const to = endpointOf(edge.to);
        if (from === undefined || to === undefined) {
            return undefined;
        }

        // the folder the edge lives in is at least the root, so ends no deeper than maxDepth are always within the
        // limit, and the folder isn't needed. With no limit (Infinity), that's every end. Kept boxes only ever let ends
        // go deeper, so they don't change this
        if (endDepth(from) <= maxDepth && endDepth(to) <= maxDepth) {
            return { from: from, to: to };
        }

        // otherwise the ends may go maxDepth below that folder
        const limit = depthOf(commonAncestor(edge.from, edge.to, info)) + maxDepth;
        return {
            from: endAtDepth(from, Math.max(limit, keptDepth(from))),
            to: endAtDepth(to, Math.max(limit, keptDepth(to))),
        };
    };
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
 * @param kept Boxes whose arrows start from the box itself even when the depth would merge them into a folder around
 *   it, like the selected box; their other ends still follow the depth.
 * @param pinned The selected arrow, if any. The graph's edges it stands for keep its two ends while both are still
 *   drawn, so it doesn't vanish when what's merged changes, and selecting it doesn't split any other arrow out.
 * @param shownKinds The kinds of edges to draw, from the arrow settings; undefined for every kind.
 * @returns One edge per pair of ends and kind with an edge between them, in the order first seen, each with the
 *   graph's edges that landed on it. An import and an event between the same two boxes are two arrows.
 */
export function visibleEdges(state: LayoutState, info: GraphInfo, rects: Map<string, Rect>, strips: Strip[] = [], maxDepth: number = Infinity, kept: string[] = [], pinned: VisibleEdge | undefined = undefined, shownKinds: Set<EdgeKind> | undefined = undefined): VisibleEdge[] {
    // one per pair of ends, in the order first seen, counting the edges that land on it
    const byEnds = new Map<string, VisibleEdge>();
    const arrowEnds = makeArrowEndFinder(state, info, rects, strips, kept);

    // a box or strip that's on screen, so an arrow can end at it
    function isDrawn(id: string): boolean {
        return rects.has(id) || strips.some(function isThisStrip(strip: Strip): boolean {
            return strip.id === id;
        });
    }

    // the selected arrow's edges keep its ends, as long as both are still drawn
    const pinnedEdges = new Set<Edge>();
    if (pinned !== undefined && isDrawn(pinned.from) && isDrawn(pinned.to)) {
        for (const edge of pinned.edges) {
            pinnedEdges.add(edge);
        }
    }

    for (const edge of info.edges) {
        // a kind the arrow settings have turned off
        if (shownKinds !== undefined && !shownKinds.has(edge.kind)) {
            continue;
        }

        let ends = arrowEnds(edge, maxDepth);
        if (pinnedEdges.has(edge)) {
            ends = { from: pinned!.from, to: pinned!.to };
        }
        if (ends === undefined) {
            continue;
        }
        const from = ends.from;
        const to = ends.to;

        // both ends inside one closed box, or behind one strip: no arrow
        if (from === to) {
            continue;
        }

        // many edges of a kind can land on the same two visible boxes. A strip's id has a newline in it, so the two
        // ends and the kind are joined with a character ids never have
        const key = from + '\u0000' + to + '\u0000' + edge.kind;
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

// a "+N" bar along a box's edge, standing in for the children it's hiding on that side
export interface Strip {
    id: string; // from stripId, so arrows can end at it like at a box
    ownerId: string; // the box it belongs to; the root's strip sits beside the top-level boxes
    side: StripSide;
    rect: Rect; // on the page
    hiddenIds: string[]; // most important first
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

    for (const id of state.expanded) {
        const box = rects.get(id);
        if (box === undefined) {
            continue;
        }

        const hidden = hiddenSides(state, info, id);

        // a strip and the padding before it, which a strip on the next side over stops short of
        const room = roomForStrips(hidden);

        // the space strips go in: inside the padding, below the title
        const inside = { x: box.x + PADDING, y: box.y + HEADER + PADDING, width: box.width - 2 * PADDING, height: box.height - HEADER - 2 * PADDING };

        // side strips run the full height between the top and bottom ones, and top and bottom strips the full width
        // between the side ones
        const sideY = inside.y + room.top;
        const sideHeight = inside.height - room.top - room.bottom;
        const acrossX = inside.x + room.left;
        const acrossWidth = inside.width - room.left - room.right;
        const sides: { side: StripSide; rect: Rect }[] = [
            { side: 'left', rect: { x: inside.x, y: sideY, width: STRIP_THICKNESS, height: sideHeight } },
            { side: 'right', rect: { x: inside.x + inside.width - STRIP_THICKNESS, y: sideY, width: STRIP_THICKNESS, height: sideHeight } },
            { side: 'top', rect: { x: acrossX, y: inside.y, width: acrossWidth, height: STRIP_THICKNESS } },
            { side: 'bottom', rect: { x: acrossX, y: inside.y + inside.height - STRIP_THICKNESS, width: acrossWidth, height: STRIP_THICKNESS } },
        ];
        for (const { side, rect } of sides) {
            if (hidden[side].length > 0) {
                strips.push({ id: stripId(id, side), ownerId: id, side: side, rect: rect, hiddenIds: hidden[side] });
            }
        }
    }

    return strips;
}
