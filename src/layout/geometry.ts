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
