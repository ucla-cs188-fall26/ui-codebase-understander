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
