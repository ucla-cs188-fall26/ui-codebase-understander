import { GAP } from './defaultLayout';
import { overlapsWithGap, Position, Rect } from './geometry';
import { changeSize, GraphInfo, growToFit, keepPageAroundBoxes, LayoutState, moveTo, placedChildRects } from './state';

// siblings closer than this count as overlapping; a pushed box moves out to the normal GAP
const MIN_GAP = 10;

// a safety stop, in case two boxes ever push each other back and forth
const MAX_STEPS = 1000;

type Direction = 'left' | 'right' | 'up' | 'down';

/**
 * Picks the way to push a box so it moves away from the box pushing it.
 * @param pusher The box doing the pushing.
 * @param other The box being pushed.
 * @returns Along whichever axis their centers are further apart, the side the other box is already on.
 */
function directionAway(pusher: Rect, other: Rect): Direction {
    const dx = (other.x + other.width / 2) - (pusher.x + pusher.width / 2);
    const dy = (other.y + other.height / 2) - (pusher.y + pusher.height / 2);
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? 'right' : 'left';
    }
    return dy >= 0 ? 'down' : 'up';
}

/**
 * Picks right or down, whichever moves a box less to clear the box pushing it. Used when pushing away would go past
 * a directory's left or top edge.
 * @param pusher The box doing the pushing.
 * @param other The box being pushed.
 * @returns 'right' or 'down'. Ties go right, the way the layout flows.
 */
function shorterOfRightAndDown(pusher: Rect, other: Rect): Direction {
    const right = pusher.x + pusher.width + GAP - other.x;
    const down = pusher.y + pusher.height + GAP - other.y;
    return right <= down ? 'right' : 'down';
}

/**
 * Moves a box just far enough in one direction to sit GAP away from the box pushing it.
 * @param pusher The box doing the pushing.
 * @param other The box being pushed. Changed in place.
 * @param direction Which way to push it.
 */
function pushClear(pusher: Rect, other: Rect, direction: Direction): void {
    if (direction === 'right') {
        other.x = pusher.x + pusher.width + GAP;
    } else if (direction === 'left') {
        other.x = pusher.x - GAP - other.width;
    } else if (direction === 'down') {
        other.y = pusher.y + pusher.height + GAP;
    } else {
        other.y = pusher.y - GAP - other.height;
    }
}

/**
 * Pushes boxes out from under a dropped box, and boxes those hit out from under them, until nothing overlaps. A pushed
 * box pushes what it hits the same way it was pushed, so a chain only ever moves away from the dropped box, never back
 * under it.
 * @param rects Every sibling's rect, the dropped box included. Not changed.
 * @param droppedId The dropped box, which never moves.
 * @param onlyRightOrDown True to push only right or down, for when pushing away would go past an edge.
 * @returns New rects for every sibling, after the pushes.
 */
function runChain(rects: Map<string, Rect>, droppedId: string, onlyRightOrDown: boolean): Map<string, Rect> {
    // copies, so the caller's rects stay as they were for comparing
    const placed = new Map<string, Rect>();
    for (const [id, rect] of rects) {
        placed.set(id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }

    // boxes whose overlaps still need checking, starting with the dropped one, and the way each was pushed
    const pushers = [droppedId];
    const pushedWay = new Map<string, Direction>();
    let steps = 0;
    while (pushers.length > 0 && steps < MAX_STEPS) {
        steps++;
        const pusherId = pushers.shift()!;
        const pusher = placed.get(pusherId)!;

        for (const [id, other] of placed) {
            if (id === pusherId || id === droppedId || !overlapsWithGap(pusher, other, MIN_GAP)) {
                continue;
            }

            // the dropped box pushes each away from itself; anything else passes its own push on
            let direction = pushedWay.get(pusherId);
            if (direction === undefined) {
                direction = onlyRightOrDown ? shorterOfRightAndDown(pusher, other) : directionAway(pusher, other);
            }
            pushClear(pusher, other, direction);
            pushedWay.set(id, direction);

            // it moved, so it may now overlap others in turn
            pushers.push(id);
        }
    }

    return placed;
}

/**
 * Checks whether any box ended up past its directory's left or top edge.
 * @param rects The boxes, relative to the top-left of their directory's whole layout.
 * @returns True if any starts left of or above 0.
 */
function anyPastEdge(rects: Map<string, Rect>): boolean {
    for (const rect of rects.values()) {
        if (rect.x < 0 || rect.y < 0) {
            return true;
        }
    }
    return false;
}

/**
 * Makes room for a dropped box: what it landed on moves away from it, and what those hit moves too, on any page, since
 * every page shares one layout and a box hidden on another page would otherwise end up under it. The dropped box stays
 * put. Inside a directory nothing goes past the layout's left or top edge; if it would, everything is pushed right or
 * down instead.
 * @param state The view state. Pushed boxes get new homes.
 * @param info The graph lookups.
 * @param droppedId The box that was just dropped.
 */
export function settleDrop(state: LayoutState, info: GraphInfo, droppedId: string): void {
    const parentId = info.nodesById.get(droppedId)!.parent!;

    // every placed sibling, on every page, so open boxes count at the size they're showing
    const before = placedChildRects(state, info, parentId);

    let after = runChain(before, droppedId, false);
    if (anyPastEdge(after)) {
        after = runChain(before, droppedId, true);
    }

    // each pushed box's home moves by as much as the box did
    for (const [id, rect] of after) {
        const old = before.get(id)!;
        const dx = rect.x - old.x;
        const dy = rect.y - old.y;
        if (dx !== 0 || dy !== 0) {
            const home = state.homes.get(id)!;
            state.homes.set(id, { x: home.x + dx, y: home.y + dy });
        }
    }

    // a box pushed left or up past where the page is drawn from would be drawn outside the directory
    keepPageAroundBoxes(state, info, parentId);

    // a drop never hides a box: directories the user sized too small for what's in them now grow to fit
    growToFit(state, info, droppedId);
}

/**
 * Drops a box at a spot among its siblings: it lands exactly there (a home is where a box is drawn), nothing it
 * didn't land on moves, and what it did land on is pushed out of the way. If that makes its directory grow, the
 * directory's own neighbors make room, the same as any size change.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The dropped box.
 * @param target Where it was let go, relative to the inside of its parent.
 */
export function dropAt(state: LayoutState, info: GraphInfo, id: string, target: Position): void {
    function drop(): void {
        moveTo(state, info, id, target);
        settleDrop(state, info, id);
    }
    changeSize(state, info, id, drop);
}

/**
 * Moves a box mid-drag: it goes where the mouse is and its directory grows to hold it, the same as a drop, so the
 * directory's neighbors make room as it drags. Nothing it's over is pushed; that waits for the drop.
 * @param state The view state.
 * @param info The graph lookups.
 * @param id The dragged box.
 * @param target Where it is now, relative to the inside of its parent.
 */
export function dragTo(state: LayoutState, info: GraphInfo, id: string, target: Position): void {
    function move(): void {
        moveTo(state, info, id, target);
        growToFit(state, info, id);
    }
    changeSize(state, info, id, move);
}
