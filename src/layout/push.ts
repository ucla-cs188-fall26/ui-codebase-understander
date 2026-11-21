import { overlapsWithGap, Position, Rect } from './geometry';

// Moving siblings out of a box's way as it changes size, and back. Each box records whom it pushed and how far, so a
// box shrinking takes back exactly what it pushed, and closing undoes opening in any order.

// one time a box moved its siblings by changing size: how far, and which ones. Growing pushes (a positive amount) and
// shrinking pulls (a negative one)
export interface Push {
    amount: number;
    ids: string[];
}

// a box's pushes in each direction, oldest first, so the box changing size the other way takes back the latest exactly
export interface Pushes {
    right: Push[];
    down: Push[];
}

/**
 * Adds to how far a box still has to move back.
 * @param owed How far each box still has to move back. Changed in place.
 * @param id The box.
 * @param dx How far across.
 * @param dy How far down.
 */
export function addOwed(owed: Map<string, Position>, id: string, dx: number, dy: number): void {
    const before = owed.get(id) ?? { x: 0, y: 0 };
    owed.set(id, { x: before.x + dx, y: before.y + dy });
}

/**
 * Makes the moves boxes owe, for each one whose way is clear now: it wouldn't land on any box it isn't already
 * touching. One that moves can clear the way for another, so it checks again until none can move.
 * @param owed How far each box still has to move back. Paid moves are cleared.
 * @param before Every sibling before this change, to tell what each was already touching.
 * @param after Where each sibling is going. Changed in place.
 */
export function payOwed(owed: Map<string, Position>, before: Map<string, Rect>, after: Map<string, Rect>): void {
    let paidOne = true;
    while (paidOne) {
        paidOne = false;
        for (const [siblingId, rect] of after) {
            const move = owed.get(siblingId);
            if (move === undefined) {
                continue;
            }
            const moved = { x: rect.x + move.x, y: rect.y + move.y, width: rect.width, height: rect.height };
            const others = new Map(after);
            others.set(siblingId, moved);
            if (!landsOnAnother(siblingId, moved, before, others)) {
                after.set(siblingId, moved);
                owed.delete(siblingId);
                paidOne = true;
            }
        }
    }
}

/**
 * Moves the boxes in a size change's paths: across by dx if beside it, down by dy if below it, or both.
 * @param before Every sibling before.
 * @param after Where each sibling goes. Changed in place.
 * @param beside The boxes in its row's path.
 * @param below The boxes in its column's path.
 * @param dx How far across.
 * @param dy How far down.
 */
export function moveInPath(before: Map<string, Rect>, after: Map<string, Rect>, beside: Set<string>, below: Set<string>, dx: number, dy: number): void {
    for (const [siblingId, rect] of before) {
        if (beside.has(siblingId) || below.has(siblingId)) {
            after.set(siblingId, {
                x: beside.has(siblingId) ? rect.x + dx : rect.x,
                y: below.has(siblingId) ? rect.y + dy : rect.y,
                width: rect.width,
                height: rect.height,
            });
        }
    }
}

/**
 * Brings along any box a pushed box would land on, moved the same way as the box that hit it, until nothing pushed
 * lands on anything it wasn't already touching. They join the push's paths, so changing back takes them back too.
 * @param before Every sibling before the push.
 * @param after Where each sibling goes. Changed in place.
 * @param beside The boxes pushed across. Grows.
 * @param below The boxes pushed down. Grows.
 * @param dx How far across.
 * @param dy How far down.
 */
export function carryAlong(before: Map<string, Rect>, after: Map<string, Rect>, beside: Set<string>, below: Set<string>, dx: number, dy: number): void {
    let carriedOne = true;
    while (carriedOne) {
        carriedOne = false;
        for (const [movedId, moved] of after) {
            if (moved === before.get(movedId)) {
                continue;
            }
            for (const [stillId, still] of after) {
                if (still !== before.get(stillId) || !overlapsWithGap(moved, still, 0) || overlapsWithGap(before.get(movedId)!, still, 0)) {
                    continue;
                }
                if (beside.has(movedId)) {
                    beside.add(stillId);
                }
                if (below.has(movedId)) {
                    below.add(stillId);
                }
                moveInPath(new Map([[stillId, still]]), after, beside, below, dx, dy);
                carriedOne = true;
            }
        }
    }
}

/**
 * Copies a box's pushes, so changing the copy leaves the state's alone (copyLayoutState shares them).
 * @param pushes The box's pushes, or undefined if it has none yet.
 * @returns A copy, with copies of each push.
 */
export function copyPushes(pushes: Pushes | undefined): Pushes {
    function copyPush(push: Push): Push {
        return { amount: push.amount, ids: [...push.ids] };
    }
    if (pushes === undefined) {
        return { right: [], down: [] };
    }
    return { right: pushes.right.map(copyPush), down: pushes.down.map(copyPush) };
}

/**
 * Takes back a box's latest pushes in one direction, as far as a change of size the other way goes: shrinking takes
 * back the latest pushes, and growing gives back the latest pulls. A push taken back in full is gone; one taken back
 * partly keeps what's left.
 * @param pushes The box's pushes in that direction, oldest first. Changed in place, so pass a copy.
 * @param change How much the box changed size that way.
 * @param rects The siblings' rects, moved in place as their pushes are taken back.
 * @param direction 'right' to move them across, 'down' to move them down.
 * @returns How much of the change was used up.
 */
export function takeBackPushes(pushes: Push[], change: number, rects: Map<string, Rect>, direction: 'right' | 'down'): number {
    let taken = 0;
    while (pushes.length > 0) {
        const latest = pushes[pushes.length - 1];
        const left = change - taken;
        if (left === 0 || Math.sign(latest.amount) === Math.sign(left)) {
            break;
        }

        // as much of the latest push as the change covers
        const step = Math.sign(left) * Math.min(Math.abs(latest.amount), Math.abs(left));
        for (const siblingId of latest.ids) {
            const rect = rects.get(siblingId);
            if (rect !== undefined) {
                const x = direction === 'right' ? rect.x + step : rect.x;
                const y = direction === 'down' ? rect.y + step : rect.y;
                rects.set(siblingId, { x: x, y: y, width: rect.width, height: rect.height });
            }
        }
        taken += step;

        // what's left of it, unless it's all taken back (give or take rounding)
        const remaining = latest.amount + step;
        pushes.pop();
        if (Math.abs(remaining) > 0.000001) {
            pushes.push({ amount: remaining, ids: latest.ids });
        }
    }
    return taken;
}

/**
 * Lists the boxes a push actually moved: the ones in its path whose rect changed.
 * @param inPath The boxes in its path.
 * @param before Every sibling before the push.
 * @param after Every sibling after it.
 * @returns Their ids.
 */
export function movedFrom(inPath: Set<string>, before: Map<string, Rect>, after: Map<string, Rect>): string[] {
    const moved: string[] = [];
    for (const siblingId of inPath) {
        if (after.get(siblingId) !== before.get(siblingId)) {
            moved.push(siblingId);
        }
    }
    return moved;
}

/**
 * Takes a sibling out of a box's pushes, so changing the box's size won't move it back.
 * @param pushes The box's pushes. Changed in place, so pass a copy.
 * @param siblingId The sibling.
 */
export function forgetPushed(pushes: Pushes, siblingId: string): void {
    for (const push of pushes.right.concat(pushes.down)) {
        const index = push.ids.indexOf(siblingId);
        if (index !== -1) {
            push.ids.splice(index, 1);
        }
    }
}

/**
 * Keeps boxes from being pulled onto each other. A box whose pull would land it on a box it wasn't already overlapping
 * stays where it was instead. That can put it in another pulled box's way, so it checks again until nothing lands on
 * anything; each pass only puts boxes back, so it always stops.
 * @param before Every sibling's rect before the pull.
 * @param after Where each sibling would go. Changed in place.
 */
export function cancelPullsOntoOthers(before: Map<string, Rect>, after: Map<string, Rect>): void {
    let cancelledOne = true;
    while (cancelledOne) {
        cancelledOne = false;
        for (const [id, rect] of after) {
            const start = before.get(id)!;
            const moved = rect.x !== start.x || rect.y !== start.y;
            if (moved && landsOnAnother(id, rect, before, after)) {
                after.set(id, start);
                cancelledOne = true;
            }
        }
    }
}

/**
 * Checks whether a box at a new spot overlaps a sibling it didn't overlap before.
 * @param id The box.
 * @param rect Where it would be.
 * @param before Every sibling's rect before the pull.
 * @param after Where every sibling would be.
 * @returns True if it lands on one.
 */
function landsOnAnother(id: string, rect: Rect, before: Map<string, Rect>, after: Map<string, Rect>): boolean {
    for (const [otherId, other] of after) {
        if (otherId === id) {
            continue;
        }
        const overlapsNow = overlapsWithGap(rect, other, 0);
        const overlappedBefore = overlapsWithGap(before.get(id)!, before.get(otherId)!, 0);
        if (overlapsNow && !overlappedBefore) {
            return true;
        }
    }
    return false;
}

/**
 * Finds the boxes in a growing box's path in one direction: those past its edge that share its column (going down) or
 * row (going right), then those past them in theirs, since a moved box would run into them.
 * @param siblings The boxes that might be in the way, where they're drawn.
 * @param path The growing box's range across the direction (start to end) and its edge along it.
 * @param direction 'down' for a column, 'right' for a row.
 * @returns The ids of every box that has to move.
 */
export function chainInPath(siblings: Map<string, Rect>, path: { start: number; end: number; edge: number }, direction: 'down' | 'right'): Set<string> {
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
