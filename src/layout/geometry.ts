// a point, or a box's top-left corner, in pixels
export interface Position {
	x: number;
	y: number;
}

// a box's width and height, in pixels
export interface Size {
	width: number;
	height: number;
}

// a box's top-left corner and its size
export interface Rect extends Position, Size {}

/**
 * Finds the smallest rectangle that holds every given box.
 * @param rects The boxes.
 * @returns Their combined bounds, or undefined if there are none.
 */
export function boundsOf(rects: Iterable<Rect>): Rect | undefined {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const rect of rects) {
		left = Math.min(left, rect.x);
		top = Math.min(top, rect.y);
		right = Math.max(right, rect.x + rect.width);
		bottom = Math.max(bottom, rect.y + rect.height);
	}

	// no boxes: the starting values never changed
	if (left === Infinity) {
		return undefined;
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Checks whether two boxes are closer than a gap on both axes, so they would touch or overlap.
 * @param a One box.
 * @param b The other box.
 * @param gap The space they should keep between them.
 * @returns True if they are too close. Boxes exactly gap apart are fine.
 */
export function overlapsWithGap(a: Rect, b: Rect, gap: number): boolean {
	const tooCloseAcross = a.x < b.x + b.width + gap && b.x < a.x + a.width + gap;
	const tooCloseDown = a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
	return tooCloseAcross && tooCloseDown;
}

/**
 * Cuts one box out of another, leaving the parts of the first that the second doesn't cover.
 * @param a The box to cut from.
 * @param b The box to cut out.
 * @returns Up to four rectangles that don't overlap: the parts of a above, below, left of and right of b. Just a when
 *   they don't overlap, and nothing when b covers all of a.
 */
export function subtractRect(a: Rect, b: Rect): Rect[] {
	const left = Math.max(a.x, b.x);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const top = Math.max(a.y, b.y);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	if (left >= right || top >= bottom) {
		return [a];
	}

	// above and below run a's full width; left and right fill the band between them
	const pieces: Rect[] = [
		{ x: a.x, y: a.y, width: a.width, height: top - a.y },
		{ x: a.x, y: bottom, width: a.width, height: a.y + a.height - bottom },
		{ x: a.x, y: top, width: left - a.x, height: bottom - top },
		{ x: right, y: top, width: a.x + a.width - right, height: bottom - top },
	];
	const kept: Rect[] = [];
	for (const piece of pieces) {
		if (piece.width > 0 && piece.height > 0) {
			kept.push(piece);
		}
	}
	return kept;
}
