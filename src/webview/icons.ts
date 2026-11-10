// SVG elements need this namespace, or the browser treats them as unknown HTML tags
export const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Makes a 16×16 line icon. Its lines take the text color, through the icon CSS in the page.
 * @param pathData The drawing, as an SVG path on a 16×16 grid.
 * @returns The svg element.
 */
function makeIcon(pathData: string): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('viewBox', '0 0 16 16');

	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', pathData);
	svg.appendChild(path);

	return svg;
}

/**
 * Draws an X as two crossing lines, so it is symmetric whatever the font.
 * @returns The icon.
 */
export function makeCloseIcon(): SVGSVGElement {
	return makeIcon('M 4 4 L 12 12 M 12 4 L 4 12');
}

/**
 * Draws an arrow pointing up and right, the usual sign for "open elsewhere": its corner, then its shaft.
 * @returns The icon.
 */
export function makeOpenIcon(): SVGSVGElement {
	return makeIcon('M 6 4 H 12 V 10 M 12 4 L 4 12');
}

/**
 * Draws six dots in two columns, the usual sign for "you can drag this". Each dot is a zero-length line,
 * which the icon CSS gives round ends, so it shows as a small circle.
 * @returns The icon.
 */
export function makeGripIcon(): SVGSVGElement {
	return makeIcon('M 6 4 L 6 4 M 10 4 L 10 4 M 6 8 L 6 8 M 10 8 L 10 8 M 6 12 L 6 12 M 10 12 L 10 12');
}

/**
 * Draws four corner brackets, the usual sign for "fit everything in view".
 * @returns The icon.
 */
export function makeFitIcon(): SVGSVGElement {
	return makeIcon('M 3 6 V 3 H 6 M 10 3 H 13 V 6 M 13 10 V 13 H 10 M 6 13 H 3 V 10');
}

/**
 * Draws a counterclockwise arrow, the usual sign for "reset": three quarters of a circle,
 * from its left side round the bottom to its top, then an arrowhead there.
 * @returns The icon.
 */
export function makeResetIcon(): SVGSVGElement {
	return makeIcon('M 3.5 8 A 4.5 4.5 0 1 0 8 3.5 M 10 1.5 L 8 3.5 L 10 5.5');
}
