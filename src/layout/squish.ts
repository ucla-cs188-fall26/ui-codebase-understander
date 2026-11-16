import { Rect } from './geometry';

// how close boxes can be pushed together
const MIN_GAP = 10;

// how far past its room a row can reach and still fit: sizes built by adding and taking away can be off by rounding
const ROUNDING = 0.000001;

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

// a row measured for packing: its stretches, the space before each now, and the least each space can shrink to
interface MeasuredRow {
	stretches: Stretch[];
	spaces: number[];
	minSpaces: number[];
	width: number; // from the inside's left edge to the end of the last stretch, as the row is now
	tightWidth: number; // the same, packed as tight as it goes
}

/**
 * Measures a row for packing. The space before the first stretch can shrink to nothing, and the gaps between stretches
 * to MIN_GAP, or stay as they are if they're already smaller.
 * @param row The row's ids.
 * @param rects The boxes.
 * @returns Its stretches, spaces, and widths.
 */
function measureRow(row: string[], rects: Map<string, Rect>): MeasuredRow {
	const stretches = stretchesOf(row, rects);
	const spaces: number[] = [];
	const minSpaces: number[] = [];
	let tightWidth = 0;
	let end = 0;
	for (let i = 0; i < stretches.length; i++) {
		const space = stretches[i].start - end;
		const minSpace = Math.min(space, i === 0 ? 0 : MIN_GAP);
		spaces.push(space);
		minSpaces.push(minSpace);
		tightWidth += minSpace + stretches[i].end - stretches[i].start;
		end = stretches[i].end;
	}
	return { stretches: stretches, spaces: spaces, minSpaces: minSpaces, width: end, tightWidth: tightWidth };
}

/**
 * Fits one row into a width by shrinking the empty space in it, all in the same proportion, so gaps that started even
 * stay even. Boxes that overlap sideways (at different heights) keep their exact offsets, so nothing can slide onto
 * anything.
 * @param row The row's ids.
 * @param rects The boxes, relative to the inside of their directory.
 * @param width The room, from the directory's left edge to its right wall.
 * @returns The row's new rects, and whether it fit. When it can't, the boxes are placed with the smallest spaces.
 */
function packRow(row: string[], rects: Map<string, Rect>, width: number): { placed: Map<string, Rect>; fits: boolean } {
	const measured = measureRow(row, rects);

	// how much of each space's spare room is kept: 1 leaves the row as it is, 0 packs it as tight as it goes
	let keep = 1;
	if (measured.width > width + ROUNDING) {
		const spare = measured.width - measured.tightWidth;
		keep = spare > 0 ? Math.max(0, (width - measured.tightWidth) / spare) : 0;
	}

	// each stretch moves as one, so its boxes keep their offsets from each other
	const placed = new Map<string, Rect>();
	let x = 0;
	for (let i = 0; i < measured.stretches.length; i++) {
		const stretch = measured.stretches[i];
		x += measured.minSpaces[i] + (measured.spaces[i] - measured.minSpaces[i]) * keep;
		for (const id of stretch.ids) {
			const rect = rects.get(id)!;
			placed.set(id, { x: x + rect.x - stretch.start, y: rect.y, width: rect.width, height: rect.height });
		}
		x += stretch.end - stretch.start;
	}
	return { placed: placed, fits: measured.tightWidth <= width + ROUNDING };
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
 * Fits a directory's children into a width: each row's gaps shrink evenly. Rows don't affect each other.
 * @param rects The children as arranged, relative to the inside of the directory.
 * @param width The room inside the directory, from its left edge to its right wall.
 * @returns The children's new rects, and whether every row fit. One that doesn't is packed as tight as it goes.
 */
export function squishHorizontally(rects: Map<string, Rect>, width: number): { rects: Map<string, Rect>; fits: boolean } {
	const placed = new Map<string, Rect>();
	let fits = true;
	for (const row of rowsOf(rects)) {
		const packed = packRow(row, rects, width);
		for (const [id, rect] of packed.placed) {
			placed.set(id, rect);
		}
		fits = fits && packed.fits;
	}
	return { rects: placed, fits: fits };
}

/**
 * Finds the narrowest a directory's inside can get: each row packed as tight as it goes.
 * @param rects The children as arranged.
 * @returns The smallest width every row fits in, from the inside's left edge.
 */
export function tightWidth(rects: Map<string, Rect>): number {
	let widest = 0;
	for (const row of rowsOf(rects)) {
		widest = Math.max(widest, measureRow(row, rects).tightWidth);
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
 * squishHorizontally, with columns instead of rows.
 * @param rects The children as arranged, relative to the inside of the directory.
 * @param height The room inside the directory, from its top edge to its bottom wall.
 * @returns The children's new rects, and whether every column fit.
 */
export function squishVertically(rects: Map<string, Rect>, height: number): { rects: Map<string, Rect>; fits: boolean } {
	const squished = squishHorizontally(transpose(rects), height);
	return { rects: transpose(squished.rects), fits: squished.fits };
}

/**
 * Finds the shortest a directory's inside can get, the way tightWidth does across.
 * @param rects The children as arranged.
 * @returns The smallest height every column fits in, from the inside's top edge.
 */
export function tightHeight(rects: Map<string, Rect>): number {
	return tightWidth(transpose(rects));
}
