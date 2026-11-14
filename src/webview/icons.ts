// SVG elements need this namespace, or the browser treats them as unknown HTML tags
export const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Makes a 16×16 line icon. Its lines take the text color, through the icon CSS in the page.
 * @param pathData The drawing, as an SVG path on a 16×16 grid.
 * @param filledData Shapes to fill in solid instead of outlining, on the same grid; empty for none.
 * @returns The svg element.
 */
function makeIcon(pathData: string, filledData: string = ''): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('viewBox', '0 0 16 16');

	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', pathData);
	svg.appendChild(path);

	if (filledData !== '') {
		const filled = document.createElementNS(SVG_NS, 'path');
		filled.classList.add('icon-fill');
		filled.setAttribute('d', filledData);
		svg.appendChild(filled);
	}

	return svg;
}

/**
 * Draws a dot with an arrow leaving it, the sign for the arrow settings: the arrow's line and head, then the dot,
 * filled, as two half circles.
 * @returns The icon.
 */
export function makeArrowsIcon(): SVGSVGElement {
	return makeIcon('M 6.5 8 H 14 M 10.5 4.5 L 14 8 L 10.5 11.5', 'M 1.5 8 A 2.5 2.5 0 1 0 6.5 8 A 2.5 2.5 0 1 0 1.5 8 Z');
}

/**
 * Draws a gear, the usual sign for settings: a round outline with six wide teeth, few enough to read at icon size,
 * around a round hole. The edge between teeth is an arc, so the gear stays round.
 * @returns The icon.
 */
export function makeSettingsIcon(): SVGSVGElement {
	return makeIcon('M 6.4 3.3 L 6.7 1.3 L 9.3 1.3 L 9.6 3.3 A 5 5 0 0 1 11.3 4.2 L 13.1 3.5 L 14.4 5.8 L 12.9 7.0 A 5 5 0 0 1 12.9 9.0 L 14.4 10.2 L 13.1 12.5 L 11.3 11.8 A 5 5 0 0 1 9.6 12.7 L 9.3 14.7 L 6.7 14.7 L 6.4 12.7 A 5 5 0 0 1 4.7 11.8 L 2.9 12.5 L 1.6 10.2 L 3.1 9.0 A 5 5 0 0 1 3.1 7.0 L 1.6 5.8 L 2.9 3.5 L 4.7 4.2 A 5 5 0 0 1 6.4 3.3 Z M 10.2 8 A 2.2 2.2 0 1 0 5.8 8 A 2.2 2.2 0 1 0 10.2 8 Z');
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
 * Draws two short diagonal lines in the bottom-right corner, the usual sign for "drag this corner to resize".
 * @returns The icon.
 */
export function makeResizeIcon(): SVGSVGElement {
	return makeIcon('M 14 8 L 8 14 M 14 12 L 12 14');
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
