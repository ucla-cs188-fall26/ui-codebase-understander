import { Rect } from './geometry';

// how close boxes can be pushed together before anything has to hide
const MIN_GAP = 10;

// a row never hides down to fewer columns than this; with this many jammed, the directory stops shrinking. A column is
// a stretch: boxes stacked one above another count as one, since they take one box's width
const MIN_SHOWN_PER_ROW = 3;

/**
 * Checks whether two boxes would bump into each other moving sideways: their top-to-bottom ranges overlap.
 * @param a One box.
 * @param b The other box.
 * @returns True if they share a row.
 */
function sameRow(a: Rect, b: Rect): boolean {
	return a.y < b.y + b.height && b.y < a.y + a.height;
}

// a stretch of the x-axis covered by one or more of a row's boxes, with nothing between them sideways
interface Stretch {
	start: number;
	end: number;
	ids: string[];
}

/**
 * Lays a row's boxes onto the x-axis and merges the ones whose sideways ranges overlap, which happens when a row is
 * staggered: boxes at different heights can sit above one another.
 * @param row The row's ids.
 * @param rects The boxes.
 * @returns The covered stretches, left to right. The empty space between them is what can shrink.
 */
function stretchesOf(row: string[], rects: Map<string, Rect>): Stretch[] {
	function compareLeftFirst(a: string, b: string): number {
		return rects.get(a)!.x - rects.get(b)!.x;
	}

	const stretches: Stretch[] = [];
	for (const id of row.toSorted(compareLeftFirst)) {
		const rect = rects.get(id)!;
		const last = stretches[stretches.length - 1];
		if (last !== undefined && rect.x < last.end) {
			// overlaps the stretch so far sideways: same stretch
			last.end = Math.max(last.end, rect.x + rect.width);
			last.ids.push(id);
		} else {
			stretches.push({ start: rect.x, end: rect.x + rect.width, ids: [id] });
		}
	}
	return stretches;
}

/**
 * Fits one row into a width by shrinking the empty space in it, all in the same proportion, so gaps that started even
 * stay even. The space before the first box can shrink to nothing, and the gaps between boxes to MIN_GAP. Boxes that
 * overlap sideways (at different heights) keep their exact offsets, so nothing can slide onto anything.
 * @param row The row's ids.
 * @param rects The boxes, relative to the inside of their directory.
 * @param width The room, from the directory's left edge to its right wall.
 * @returns The row's new rects, and whether it fit. When it can't, the boxes are placed with the smallest spaces.
 */
function packRow(row: string[], rects: Map<string, Rect>, width: number): { placed: Map<string, Rect>; fits: boolean } {
	const stretches = stretchesOf(row, rects);

	// each stretch's space before it: now, and the least it can shrink to (never more than it is now)
	const spaces: number[] = [];
	const minSpaces: number[] = [];
	let covered = 0;
	let end = 0;
	for (let i = 0; i < stretches.length; i++) {
		const space = stretches[i].start - end;
		spaces.push(space);
		minSpaces.push(Math.min(space, i === 0 ? 0 : MIN_GAP));
		covered += stretches[i].end - stretches[i].start;
		end = stretches[i].end;
	}

	let spaceTotal = 0;
	let minSpaceTotal = 0;
	for (let i = 0; i < stretches.length; i++) {
		spaceTotal += spaces[i];
		minSpaceTotal += minSpaces[i];
	}

	// how much of each space's spare room is kept: 1 leaves the row as it is, 0 packs it as tight as it goes
	let keep = 1;
	if (covered + spaceTotal > width) {
		const spare = spaceTotal - minSpaceTotal;
		keep = spare > 0 ? (width - covered - minSpaceTotal) / spare : 0;
	}
	const fits = keep >= 0;
	keep = Math.max(0, keep);

	// each stretch moves as one, so its boxes keep their offsets from each other
	const placed = new Map<string, Rect>();
	let x = 0;
	for (let i = 0; i < stretches.length; i++) {
		x += minSpaces[i] + (spaces[i] - minSpaces[i]) * keep;
		for (const id of stretches[i].ids) {
			const rect = rects.get(id)!;
			placed.set(id, { x: x + rect.x - stretches[i].start, y: rect.y, width: rect.width, height: rect.height });
		}
		x += stretches[i].end - stretches[i].start;
	}
	return { placed: placed, fits: fits };
}

/**
 * Finds every box in the same row as a box, following overlaps, so a slightly staggered row still counts as one.
 * @param rects The boxes.
 * @param id The box to start from.
 * @returns The ids in its row, itself included.
 */
function rowOf(rects: Map<string, Rect>, id: string): string[] {
	const row = [id];
	for (let i = 0; i < row.length; i++) {
		const current = rects.get(row[i])!;
		for (const [otherId, other] of rects) {
			if (!row.includes(otherId) && sameRow(current, other)) {
				row.push(otherId);
			}
		}
	}
	return row;
}

/**
 * Picks the box latest in the flow: furthest right, and for a tie, lowest.
 * @param ids The boxes to choose from.
 * @param rects Their rects.
 * @returns The latest one's id.
 */
function latestInFlow(ids: string[], rects: Map<string, Rect>): string {
	let latest = ids[0];
	for (const id of ids) {
		const rect = rects.get(id)!;
		const best = rects.get(latest)!;
		if (rect.x > best.x || (rect.x === best.x && rect.y > best.y)) {
			latest = id;
		}
	}
	return latest;
}

/**
 * Fits a directory's children into a width: each row's gaps shrink evenly, and when a row is packed tight and still
 * doesn't fit, its latest box in the flow goes behind the right strip. A row never hides down to fewer than
 * MIN_SHOWN_PER_ROW columns (stretches). Rows don't affect each other.
 * @param rects The children as arranged, relative to the inside of the directory.
 * @param width The room inside the directory, from its left edge to its right wall.
 * @returns The shown children's new rects, the hidden ones in flow order, and whether everything fit. It doesn't when
 *   the width is below minSquishWidth, which resizing never allows.
 */
export function squishHorizontally(rects: Map<string, Rect>, width: number): { rects: Map<string, Rect>; hidden: string[]; fits: boolean } {
	const placed = new Map<string, Rect>();
	const hidden: string[] = [];
	let fits = true;

	for (const startingRow of rowsOf(rects)) {
		const row = [...startingRow];

		// each round either fits, stops at the 3-column minimum, or hides one more box, so it always ends
		while (true) {
			const packed = packRow(row, rects, width);
			if (packed.fits || stretchesOf(row, rects).length <= MIN_SHOWN_PER_ROW) {
				for (const [id, rect] of packed.placed) {
					placed.set(id, rect);
				}
				fits = fits && packed.fits;
				break;
			}

			// only this row loses a box: its latest in the flow
			const latest = latestInFlow(row, rects);
			row.splice(row.indexOf(latest), 1);
			hidden.push(latest);
		}
	}

	// hidden in flow order, leftmost first, which is the order they'd come back in
	function compareFlow(a: string, b: string): number {
		const rectA = rects.get(a)!;
		const rectB = rects.get(b)!;
		return rectA.x !== rectB.x ? rectA.x - rectB.x : rectA.y - rectB.y;
	}
	return { rects: placed, hidden: hidden.toSorted(compareFlow), fits: fits };
}

/**
 * Splits boxes into rows: groups that would bump into each other moving sideways.
 * @param rects The boxes.
 * @returns Each row's ids.
 */
function rowsOf(rects: Map<string, Rect>): string[][] {
	const rows: string[][] = [];
	const done = new Set<string>();
	for (const id of rects.keys()) {
		if (done.has(id)) {
			continue;
		}
		const row = rowOf(rects, id);
		for (const member of row) {
			done.add(member);
		}
		rows.push(row);
	}
	return rows;
}

/**
 * Finds the narrowest a directory's inside can get before a row would have to hide more than it's allowed: each row's
 * first MIN_SHOWN_PER_ROW columns (stretches), each as wide as it covers, packed MIN_GAP apart.
 * @param rects The children as arranged.
 * @returns The smallest width that still fits, from the inside's left edge.
 */
export function minSquishWidth(rects: Map<string, Rect>): number {
	let widest = 0;
	for (const row of rowsOf(rects)) {
		// stretches come left to right, so these are the start of the flow; stacked boxes count once
		const firstColumns = stretchesOf(row, rects).slice(0, MIN_SHOWN_PER_ROW);
		let width = MIN_GAP * (firstColumns.length - 1);
		for (const column of firstColumns) {
			width += column.end - column.start;
		}
		widest = Math.max(widest, width);
	}
	return widest;
}

/**
 * Swaps each box's across and down, so columns become rows. The horizontal functions then handle the bottom wall too.
 * @param rects The boxes.
 * @returns New rects with x and y, and width and height, swapped. Doing it twice gives back the original.
 */
function transpose(rects: Map<string, Rect>): Map<string, Rect> {
	const swapped = new Map<string, Rect>();
	for (const [id, rect] of rects) {
		swapped.set(id, { x: rect.y, y: rect.x, width: rect.height, height: rect.width });
	}
	return swapped;
}

/**
 * Fits a directory's children into a height, like a wall moving up from the bottom: the same rules as
 * squishHorizontally, with columns instead of rows, and the lowest box in a jammed column hiding first.
 * @param rects The children as arranged, relative to the inside of the directory.
 * @param height The room inside the directory, from its top edge to its bottom wall.
 * @returns The shown children's new rects, the hidden ones in flow order, and whether everything fit.
 */
export function squishVertically(rects: Map<string, Rect>, height: number): { rects: Map<string, Rect>; hidden: string[]; fits: boolean } {
	const squished = squishHorizontally(transpose(rects), height);
	return { rects: transpose(squished.rects), hidden: squished.hidden, fits: squished.fits };
}

/**
 * Finds the shortest a directory's inside can get before a column would have to hide more than it's allowed.
 * @param rects The children as arranged.
 * @returns The smallest height that still fits, from the inside's top edge.
 */
export function minSquishHeight(rects: Map<string, Rect>): number {
	return minSquishWidth(transpose(rects));
}
