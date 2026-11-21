import { GAP } from './defaultLayout';
import { Position, Rect, Size } from './geometry';
import type { PageCell } from './state';

// cutting a directory's children into pages: helpers that only work on the positions and sizes they're given, and never
// look at or change the view state

/**
 * Names a page, to look up where it's drawn from.
 * @param cell The page.
 * @returns Its column and row, like "1,0".
 */
export function cellKey(cell: PageCell): string {
    return cell.column + ',' + cell.row;
}

/**
 * Finds which page a spot in a directory's layout is on: the one holding it.
 * @param position A spot in the layout, like a box's home.
 * @param anchor Where the pages are cut from.
 * @param size The directory's page size.
 * @returns How many pages across and down it is from the anchor.
 */
export function cellOf(position: Position, anchor: Position, size: Size): PageCell {
    return {
        column: Math.floor((position.x - anchor.x) / size.width),
        row: Math.floor((position.y - anchor.y) / size.height),
    };
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
export function spansNoMore(ids: string[], startOf: (id: string) => number, origin: number, natural: number, room: number): boolean {
    let last = -Infinity;
    for (const id of ids) {
        last = Math.max(last, startOf(id));
    }
    return last - origin < Math.max(natural, room + GAP);
}

/**
 * Finds the top-left of some boxes: the furthest left and furthest up any of them starts.
 * @param rects Every box.
 * @param ids The ones to measure.
 * @returns Their top-left.
 */
export function cornerOf(rects: Map<string, Rect>, ids: string[]): Position {
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
export function drawnFrom(rects: Map<string, Rect>, ids: string[], origin: Position): Map<string, Rect> {
    const moved = new Map<string, Rect>();
    for (const id of ids) {
        const rect = rects.get(id)!;
        moved.set(id, { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height });
    }
    return moved;
}

// a run of children cut along one direction, holding every child that starts in it
export interface Cut {
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
export function cutAlong(ids: string[], startOf: (id: string) => number, anchor: number, fits: (run: string[], hasBefore: boolean, hasAfter: boolean, atAnchor: boolean) => boolean): Cut[] {
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
