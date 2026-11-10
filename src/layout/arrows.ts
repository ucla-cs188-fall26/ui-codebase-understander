import { Edge } from '../graph/types';
import { Position, Rect } from './geometry';

export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * Finds the middle of a box.
 * @param rect The box.
 * @returns Its center point.
 */
function centerOf(rect: Rect): Position {
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Picks the side of each box an arrow should use: the sides that face each other. It goes by the gaps between the
 * boxes' edges, not their centers, so a long thin box like a strip connects on the side that faces the other box.
 * @param from The box the arrow leaves.
 * @param to The box the arrow enters.
 * @returns The side on each box.
 */
export function chooseSides(from: Rect, to: Rect): { fromSide: Side; toSide: Side } {
	const fromCenter = centerOf(from);
	const toCenter = centerOf(to);

	// positive dx: the target is to the right; positive dy: the target is below
	const dx = toCenter.x - fromCenter.x;
	const dy = toCenter.y - fromCenter.y;

	// how far apart the edges are, sideways and up-and-down; below zero means their ranges overlap that way
	const gapAcross = Math.max(to.x - (from.x + from.width), from.x - (to.x + to.width));
	const gapDown = Math.max(to.y - (from.y + from.height), from.y - (to.y + to.height));

	// apart more sideways than up and down: use left and right sides. Overlapping both ways (one inside the other)
	// falls back to the centers. Ties go sideways, the way the layout flows
	const sideways = gapAcross < 0 && gapDown < 0 ? Math.abs(dx) >= Math.abs(dy) : gapAcross >= gapDown;
	if (sideways) {
		if (dx >= 0) {
			return { fromSide: 'right', toSide: 'left' };
		}
		return { fromSide: 'left', toSide: 'right' };
	}

	if (dy >= 0) {
		return { fromSide: 'bottom', toSide: 'top' };
	}
	return { fromSide: 'top', toSide: 'bottom' };
}

/**
 * Finds a point part of the way along one side of a box.
 * @param rect The box.
 * @param side Which side.
 * @param fraction How far along: 0 is the top or left end of the side, 1 the bottom or right end.
 * @returns The point on the box's edge.
 */
export function pointOnSide(rect: Rect, side: Side, fraction: number): Position {
	if (side === 'left') {
		return { x: rect.x, y: rect.y + fraction * rect.height };
	}
	if (side === 'right') {
		return { x: rect.x + rect.width, y: rect.y + fraction * rect.height };
	}
	if (side === 'top') {
		return { x: rect.x + fraction * rect.width, y: rect.y };
	}
	return { x: rect.x + fraction * rect.width, y: rect.y + rect.height };
}

// where one arrow leaves its box and where it enters the other
export interface Arrow {
	from: string;
	to: string;
	start: Position;
	startSide: Side;
	end: Position;
	endSide: Side;
}

// one end of an arrow, waiting for its spot along a side
interface WaitingEnd {
	arrowIndex: number;
	isStart: boolean;
	otherCenter: Position; // where the arrow's other box is, so ends can be sorted to avoid crossings
}

// every end waiting on one side of one box
interface SideGroup {
	rect: Rect;
	side: Side;
	ends: WaitingEnd[];
}

/**
 * Reads the part of a point that runs along a side: up and down for left and right sides, across for top and bottom.
 * @param point The point.
 * @param side The side the point is being compared along.
 * @returns The point's y for a left or right side, its x for a top or bottom side.
 */
function coordinateAlong(point: Position, side: Side): number {
	if (side === 'left' || side === 'right') {
		return point.y;
	}
	return point.x;
}

/**
 * Orders the ends on one side the same way their other boxes are ordered, so arrows don't cross at the box.
 * @param ends The ends waiting on one side.
 * @param side Which side they are on.
 * @returns A sorted copy. Ties keep their edge order.
 */
function sortAlongSide(ends: WaitingEnd[], side: Side): WaitingEnd[] {
	function compareAlong(a: WaitingEnd, b: WaitingEnd): number {
		return coordinateAlong(a.otherCenter, side) - coordinateAlong(b.otherCenter, side);
	}
	return ends.toSorted(compareAlong);
}

/**
 * Works out where every arrow starts and ends, spreading arrows that share a side evenly along it.
 * @param edges The edges to draw.
 * @param rects Every box at either end of an edge, by id.
 * @returns One arrow per edge, in the same order.
 */
export function placeArrows(edges: Edge[], rects: Map<string, Rect>): Arrow[] {
	const arrows: Arrow[] = [];

	// keyed by box id and side, like "src/app left"
	const groups = new Map<string, SideGroup>();

	function addEnd(boxId: string, side: Side, end: WaitingEnd): void {
		const key = boxId + ' ' + side;
		const group = groups.get(key) ?? { rect: rects.get(boxId)!, side: side, ends: [] };
		group.ends.push(end);
		groups.set(key, group);
	}

	for (let i = 0; i < edges.length; i++) {
		const edge = edges[i];
		const fromRect = rects.get(edge.from)!;
		const toRect = rects.get(edge.to)!;
		const sides = chooseSides(fromRect, toRect);

		// the points are placeholders until every arrow on each side is known
		arrows.push({
			from: edge.from,
			to: edge.to,
			start: { x: 0, y: 0 },
			startSide: sides.fromSide,
			end: { x: 0, y: 0 },
			endSide: sides.toSide,
		});

		addEnd(edge.from, sides.fromSide, { arrowIndex: i, isStart: true, otherCenter: centerOf(toRect) });
		addEnd(edge.to, sides.toSide, { arrowIndex: i, isStart: false, otherCenter: centerOf(fromRect) });
	}

	for (const group of groups.values()) {
		const ends = sortAlongSide(group.ends, group.side);

		// n ends sit at 1/(n+1), 2/(n+1), ... along the side: evenly spaced, never at a corner
		for (let i = 0; i < ends.length; i++) {
			const point = pointOnSide(group.rect, group.side, (i + 1) / (ends.length + 1));
			const arrow = arrows[ends[i].arrowIndex];
			if (ends[i].isStart) {
				arrow.start = point;
			} else {
				arrow.end = point;
			}
		}
	}

	return arrows;
}

// the shortest distance a curve's pull points sit from its ends, so short arrows still bend visibly
const MIN_PULL = 30;

/**
 * Gives the direction pointing straight out of a side.
 * @param side The side.
 * @returns A step of length 1 away from the box.
 */
function directionOf(side: Side): Position {
	if (side === 'left') {
		return { x: -1, y: 0 };
	}
	if (side === 'right') {
		return { x: 1, y: 0 };
	}
	if (side === 'top') {
		return { x: 0, y: -1 };
	}
	return { x: 0, y: 1 };
}

/**
 * Draws an arrow as a smooth curve that leaves and enters its boxes head-on.
 * @param arrow The arrow, from placeArrows.
 * @returns An SVG path: move to the start, then a cubic curve through two pull points to the end.
 */
export function arrowPath(arrow: Arrow): string {
	// pull further for longer arrows, so they curve gently instead of kinking
	const distance = Math.hypot(arrow.end.x - arrow.start.x, arrow.end.y - arrow.start.y);
	const pull = Math.max(MIN_PULL, distance / 2);

	const startDirection = directionOf(arrow.startSide);
	const endDirection = directionOf(arrow.endSide);

	// each pull point sits straight out from its side
	const pull1 = { x: arrow.start.x + startDirection.x * pull, y: arrow.start.y + startDirection.y * pull };
	const pull2 = { x: arrow.end.x + endDirection.x * pull, y: arrow.end.y + endDirection.y * pull };

	return 'M ' + arrow.start.x + ' ' + arrow.start.y
		+ ' C ' + pull1.x + ' ' + pull1.y
		+ ', ' + pull2.x + ' ' + pull2.y
		+ ', ' + arrow.end.x + ' ' + arrow.end.y;
}
