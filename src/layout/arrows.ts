import { Edge } from '../graph/types';
import { Position, Rect } from './geometry';

export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * Picks how thick an arrow draws: thicker the more of the graph's edges it stands for, growing slower as the count
 * rises, up to a limit, so one busy arrow can't drown out the rest.
 * @param count How many edges it stands for.
 * @returns Its line width, in pixels: 1.5 for one edge, at most 5.
 */
export function arrowWidth(count: number): number {
	return Math.min(5, 1.5 + Math.log2(count));
}

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

// where one arrow leaves its box and where it enters the other
export interface Arrow {
	from: string;
	to: string;
	start: Position;
	startSide: Side;
	end: Position;
	endSide: Side;
}

// how far in from a box's corner an arrow can attach, past its rounded corner
const END_INSET = 10;

// the room left between two arrows' ends on one side, beyond what their lines or heads take
const END_GAP = 4;

// one end of an arrow, waiting for its spot along a side
interface WaitingEnd {
	arrowIndex: number;
	isStart: boolean;
	other: Rect; // the arrow's other box, which decides where this end would like to be
	preferred: number; // where along the side this end would like to be
	size: number; // how much room it takes along the side: its line's width, or its head's for the end it points into
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
 * Finds the stretch of a side arrows can attach to: its whole length, less END_INSET at each corner.
 * @param rect The box.
 * @param side The side.
 * @returns Where the stretch starts and ends, along the side. A side too short for the insets is just its middle.
 */
function usableStretch(rect: Rect, side: Side): { start: number; end: number } {
	let start = rect.y;
	let length = rect.height;
	if (side === 'top' || side === 'bottom') {
		start = rect.x;
		length = rect.width;
	}
	if (length < 2 * END_INSET) {
		return { start: start + length / 2, end: start + length / 2 };
	}
	return { start: start + END_INSET, end: start + length - END_INSET };
}

/**
 * Finds where along a side an arrow's end would like to be: where the two boxes overlap along it, so the arrow runs
 * straight across, or else the point nearest the other box.
 * @param rect The end's box.
 * @param side The side it's on.
 * @param other The arrow's other box.
 * @returns A spot along the side, within its usable stretch.
 */
function preferredSpot(rect: Rect, side: Side, other: Rect): number {
	const stretch = usableStretch(rect, side);

	// the other box's usable stretch in the same direction; its side facing this one runs the same way
	const otherStretch = usableStretch(other, side);

	// overlapping: the middle of where both stretches overlap, which the other end works out the same way, so the
	// arrow is straight
	const low = Math.max(stretch.start, otherStretch.start);
	const high = Math.min(stretch.end, otherStretch.end);
	if (low <= high) {
		return (low + high) / 2;
	}

	// apart: the end of the stretch nearest the other box
	if (otherStretch.end < stretch.start) {
		return stretch.start;
	}
	return stretch.end;
}

/**
 * Finds the room two neighboring ends need between their spots: half of each one's size, plus a gap.
 * @param a One end.
 * @param b The next end along.
 * @returns The distance between their spots.
 */
function spacingBetween(a: WaitingEnd, b: WaitingEnd): number {
	return a.size / 2 + b.size / 2 + END_GAP;
}

/**
 * Finds how much room a side's ends need, end to end.
 * @param ends The ends, in order along the side.
 * @returns The total distance from the first spot to the last.
 */
function roomNeeded(ends: WaitingEnd[]): number {
	let room = 0;
	for (let i = 1; i < ends.length; i++) {
		room += spacingBetween(ends[i - 1], ends[i]);
	}
	return room;
}

/**
 * Orders the ends on one side by where they'd like to be, so arrows don't cross at the box; ties go by where their
 * other boxes are, then by edge order.
 * @param ends The ends waiting on one side.
 * @param side Which side they are on.
 * @returns A sorted copy.
 */
function sortAlongSide(ends: WaitingEnd[], side: Side): WaitingEnd[] {
	function compareAlong(a: WaitingEnd, b: WaitingEnd): number {
		if (a.preferred !== b.preferred) {
			return a.preferred - b.preferred;
		}
		return coordinateAlong(centerOf(a.other), side) - coordinateAlong(centerOf(b.other), side);
	}
	return ends.toSorted(compareAlong);
}

/**
 * Finds the sides next to a side, at its start and its end: above and below a left or right side, left and right of a
 * top or bottom one.
 * @param side The side.
 * @returns The side next to its start, and the side next to its end.
 */
function neighborsOf(side: Side): { atStart: Side; atEnd: Side } {
	if (side === 'left' || side === 'right') {
		return { atStart: 'top', atEnd: 'bottom' };
	}
	return { atStart: 'left', atEnd: 'right' };
}

/**
 * Gives each end on a side its spot: where it'd like to be, nudged apart just enough that no two are closer than they
 * need, keeping their order. When they can't all fit, they spread evenly, which gives each as much room as there is.
 * @param ends The ends, sorted along the side.
 * @param rect The box.
 * @param side The side.
 * @returns Each end's spot along the side, in the same order.
 */
function spotsAlongSide(ends: WaitingEnd[], rect: Rect, side: Side): number[] {
	const stretch = usableStretch(rect, side);

	// too crowded even after spilling: evenly spaced over the whole side, never at a corner
	if (roomNeeded(ends) > stretch.end - stretch.start) {
		const spots: number[] = [];
		const start = coordinateAlong(rect, side);
		const length = side === 'left' || side === 'right' ? rect.height : rect.width;
		for (let i = 0; i < ends.length; i++) {
			spots.push(start + (i + 1) / (ends.length + 1) * length);
		}
		return spots;
	}

	// forward: each at least its spacing past the one before; then back, so the last fits, pulling earlier ones along
	const spots: number[] = [];
	for (let i = 0; i < ends.length; i++) {
		let spot = Math.max(ends[i].preferred, stretch.start);
		if (i > 0) {
			spot = Math.max(spot, spots[i - 1] + spacingBetween(ends[i - 1], ends[i]));
		}
		spots.push(spot);
	}
	for (let i = ends.length - 1; i >= 0; i--) {
		let limit = stretch.end;
		if (i < ends.length - 1) {
			limit = spots[i + 1] - spacingBetween(ends[i], ends[i + 1]);
		}
		spots[i] = Math.min(spots[i], limit);
	}
	return spots;
}

/**
 * Finds a point on one side of a box, at a spot along it.
 * @param rect The box.
 * @param side Which side.
 * @param spot Where along the side: a y for a left or right side, an x for a top or bottom one.
 * @returns The point on the box's edge.
 */
function pointAt(rect: Rect, side: Side, spot: number): Position {
	if (side === 'left') {
		return { x: rect.x, y: spot };
	}
	if (side === 'right') {
		return { x: rect.x + rect.width, y: spot };
	}
	if (side === 'top') {
		return { x: spot, y: rect.y };
	}
	return { x: spot, y: rect.y + rect.height };
}

/**
 * Works out where every arrow starts and ends. Each end goes where it points: straight across where its two boxes
 * overlap, or else the point nearest the other box. Ends sharing a side are nudged apart just enough not to overlap,
 * keeping their order. A side too crowded for that spills its outermost ends onto the sides next to it, the ones
 * whose other boxes lie furthest that way first; a side still too crowded spreads its ends evenly.
 * @param edges The edges to draw; one with a count draws thicker, so its ends need more room.
 * @param rects Every box at either end of an edge, by id.
 * @returns One arrow per edge, in the same order.
 */
export function placeArrows(edges: (Edge & { count?: number })[], rects: Map<string, Rect>): Arrow[] {
	const arrows: Arrow[] = [];

	// keyed by box id and side, like "src/app left"
	const groups = new Map<string, SideGroup>();
	function groupFor(boxId: string, side: Side): SideGroup {
		const key = boxId + ' ' + side;
		let group = groups.get(key);
		if (group === undefined) {
			group = { rect: rects.get(boxId)!, side: side, ends: [] };
			groups.set(key, group);
		}
		return group;
	}

	// which box each end belongs to, so a spilled end can find its new side's group
	const boxOfEnd = new Map<WaitingEnd, string>();

	for (let i = 0; i < edges.length; i++) {
		const edge = edges[i];
		const fromRect = rects.get(edge.from)!;
		const toRect = rects.get(edge.to)!;
		const sides = chooseSides(fromRect, toRect);
		const width = arrowWidth(edge.count ?? 1);

		// the points are placeholders until every arrow on each side is known
		arrows.push({
			from: edge.from,
			to: edge.to,
			start: { x: 0, y: 0 },
			startSide: sides.fromSide,
			end: { x: 0, y: 0 },
			endSide: sides.toSide,
		});

		const start: WaitingEnd = {
			arrowIndex: i,
			isStart: true,
			other: toRect,
			preferred: preferredSpot(fromRect, sides.fromSide, toRect),
			size: width,
		};
		const end: WaitingEnd = {
			arrowIndex: i,
			isStart: false,
			other: fromRect,
			preferred: preferredSpot(toRect, sides.toSide, fromRect),
			size: headLength(width),
		};
		groupFor(edge.from, sides.fromSide).ends.push(start);
		groupFor(edge.to, sides.toSide).ends.push(end);
		boxOfEnd.set(start, edge.from);
		boxOfEnd.set(end, edge.to);
	}

	// crowded sides spill onto the sides next to them. Every side decides from the ends it started with, and the moves
	// happen after, so an end moves at most once
	const moves: { end: WaitingEnd; boxId: string; side: Side }[] = [];
	for (const group of groups.values()) {
		let ends = sortAlongSide(group.ends, group.side);
		const stretch = usableStretch(group.rect, group.side);
		const neighbors = neighborsOf(group.side);
		const middle = (stretch.start + stretch.end) / 2;

		while (ends.length > 1 && roomNeeded(ends) > stretch.end - stretch.start) {
			// the outermost end whose other box lies furthest past the middle goes to the side on its way
			const first = ends[0];
			const last = ends[ends.length - 1];
			const firstReach = middle - coordinateAlong(centerOf(first.other), group.side);
			const lastReach = coordinateAlong(centerOf(last.other), group.side) - middle;
			let moving = last;
			let newSide = neighbors.atEnd;
			if (firstReach > lastReach) {
				moving = first;
				newSide = neighbors.atStart;
			}
			ends = ends.filter(function isStaying(end: WaitingEnd): boolean {
				return end !== moving;
			});

			moves.push({ end: moving, boxId: boxOfEnd.get(moving)!, side: newSide });
		}
		group.ends = ends;
	}

	// on its new side, a moved end would like to be as near its other box as that side allows
	for (const move of moves) {
		const group = groupFor(move.boxId, move.side);
		move.end.preferred = preferredSpot(group.rect, move.side, move.end.other);
		group.ends.push(move.end);
		const arrow = arrows[move.end.arrowIndex];
		if (move.end.isStart) {
			arrow.startSide = move.side;
		} else {
			arrow.endSide = move.side;
		}
	}

	for (const group of groups.values()) {
		const ends = sortAlongSide(group.ends, group.side);
		const spots = spotsAlongSide(ends, group.rect, group.side);
		for (let i = 0; i < ends.length; i++) {
			const point = pointAt(group.rect, group.side, spots[i]);
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
 * Finds how long an arrow's head is, and as wide at its base: bigger for thicker arrows, so the line never shows past
 * the head's sides.
 * @param width The arrow's line width, from arrowWidth.
 * @returns The head's length, in pixels: 9 for a normal 1.5px arrow, the size heads have always been.
 */
export function headLength(width: number): number {
	return 6 + 2 * width;
}

/**
 * Works out an arrow's head: a triangle with its tip on the arrow's end, pointing into the box. The curve always
 * arrives head-on, so the head lines up with the side it ends at. Thicker arrows get bigger heads, so the line never
 * shows past the head's sides.
 * @param arrow The arrow, from placeArrows.
 * @param width The arrow's line width, from arrowWidth.
 * @returns How long the head is along the arrow, and the triangle as SVG path data.
 */
export function arrowHead(arrow: Arrow, width: number): { length: number; path: string } {
	const length = headLength(width);

	// back from the tip, out of the box, to the middle of the head's base; then half the base to each side
	const out = directionOf(arrow.endSide);
	const base = { x: arrow.end.x + out.x * length, y: arrow.end.y + out.y * length };
	const across = { x: -out.y * length / 2, y: out.x * length / 2 };

	const path = 'M ' + arrow.end.x + ' ' + arrow.end.y
		+ ' L ' + (base.x + across.x) + ' ' + (base.y + across.y)
		+ ' L ' + (base.x - across.x) + ' ' + (base.y - across.y)
		+ ' Z';
	return { length: length, path: path };
}

/**
 * Draws an arrow as a smooth curve that leaves and enters its boxes head-on.
 * @param arrow The arrow, from placeArrows.
 * @param endGap How far before the arrow's end the curve stops, straight out from the side it ends at, so an
 *   arrowhead can fill the rest. The curve's shape doesn't change.
 * @returns An SVG path: move to the start, then a cubic curve through two pull points to the end.
 */
export function arrowPath(arrow: Arrow, endGap: number = 0): string {
	// pull further for longer arrows, so they curve gently instead of kinking
	const distance = Math.hypot(arrow.end.x - arrow.start.x, arrow.end.y - arrow.start.y);
	const pull = Math.max(MIN_PULL, distance / 2);

	const startDirection = directionOf(arrow.startSide);
	const endDirection = directionOf(arrow.endSide);

	// each pull point sits straight out from its side
	const pull1 = { x: arrow.start.x + startDirection.x * pull, y: arrow.start.y + startDirection.y * pull };
	const pull2 = { x: arrow.end.x + endDirection.x * pull, y: arrow.end.y + endDirection.y * pull };
	const end = { x: arrow.end.x + endDirection.x * endGap, y: arrow.end.y + endDirection.y * endGap };

	return 'M ' + arrow.start.x + ' ' + arrow.start.y
		+ ' C ' + pull1.x + ' ' + pull1.y
		+ ', ' + pull2.x + ' ' + pull2.y
		+ ', ' + end.x + ' ' + end.y;
}
