import { importanceScore } from '../analysis/metrics';
import { Size } from './geometry';

// box sizes in pixels, starting guesses to tune once the graph is on screen
const MIN_WIDTH = 120;
const MAX_WIDTH = 260;
const MIN_HEIGHT = 36;
const MAX_HEIGHT = 84;

// the score at which a box reaches its maximum size
const MAX_SCORE = 16;

/**
 * Works out how big a node's box should be.
 * @param childCount The node's direct children.
 * @param indegree The edges entering the node from outside it.
 * @returns The box width and height in pixels.
 */
export function nodeSize(childCount: number, indegree: number): Size {
	const score = importanceScore(childCount, indegree);
	const scale = Math.min(score / MAX_SCORE, 1);

	return {
		width: MIN_WIDTH + scale * (MAX_WIDTH - MIN_WIDTH),
		height: MIN_HEIGHT + scale * (MAX_HEIGHT - MIN_HEIGHT),
	};
}
