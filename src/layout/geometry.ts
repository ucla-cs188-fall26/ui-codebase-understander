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
