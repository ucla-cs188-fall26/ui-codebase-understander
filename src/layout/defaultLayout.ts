import { Edge } from '../graph/types';
import { assignColumns } from './columns';
import { Position, Size } from './geometry';

// space between boxes in pixels, the same everywhere so padding is even; a starting guess to tune on screen
export const GAP = 40;

/**
 * Measures one column, so columns can be placed side by side and centered.
 * @param ids The column's children, top to bottom.
 * @param sizes Every child's box size.
 * @returns The widest box's width, and the height of all boxes plus the gaps between them.
 */
function measureColumn(ids: string[], sizes: Map<string, Size>): Size {
	let width = 0;
	let height = 0;
	for (const id of ids) {
		const size = sizes.get(id)!;
		width = Math.max(width, size.width);
		height += size.height;
	}

	// one gap between each pair of boxes
	height += GAP * (ids.length - 1);

	return { width: width, height: height };
}

/**
 * Lists each column's children from top to bottom.
 * @param childIds A parent's children, most important first.
 * @param columns Each child's column, from assignColumns.
 * @returns One list per column, left to right, each most important first.
 */
function groupByColumn(childIds: string[], columns: Map<string, number>): string[][] {
	const groups: string[][] = [];

	// loop over childIds, not the map: the map is in the order columns were worked out, not importance order
	for (const id of childIds) {
		const column = columns.get(id)!;

		// make room for this column; columns can turn up out of order
		while (groups.length <= column) {
			groups.push([]);
		}

		groups[column].push(id);
	}

	return groups;
}

/**
 * Places a parent's children left to right, so each sits one column right of whatever points at it.
 * @param childIds The parent's children, most important first. The most important goes at the top of its column.
 * @param edges The edges between those children, from liftEdges.
 * @param sizes Every child's box size.
 * @returns Every child's top-left corner, measured from the parent's top-left.
 */
export function defaultLayout(childIds: string[], edges: Edge[], sizes: Map<string, Size>): Map<string, Position> {
	const groups = groupByColumn(childIds, assignColumns(childIds, edges));

	const measured: Size[] = [];
	for (const ids of groups) {
		measured.push(measureColumn(ids, sizes));
	}

	// every column is centered against the tallest one
	let tallest = 0;
	for (const size of measured) {
		tallest = Math.max(tallest, size.height);
	}

	const positions = new Map<string, Position>();
	let x = 0;
	for (let column = 0; column < groups.length; column++) {
		let y = (tallest - measured[column].height) / 2;
		for (const id of groups[column]) {
			positions.set(id, { x: x, y: y });
			y += sizes.get(id)!.height + GAP;
		}
		x += measured[column].width + GAP;
	}

	return positions;
}
