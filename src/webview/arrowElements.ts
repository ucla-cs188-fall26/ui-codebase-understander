import { Edge, EdgeKind } from '../graph/types';
import { Arrow, arrowBounds, arrowHead, arrowPath, arrowWidth } from '../layout/arrows';
import { Rect } from '../layout/geometry';
import { VisibleEdge } from '../layout/place';
import { SVG_NS } from './icons';
import { redraw, view } from './view';

// the svg for one arrow: its line and head, cut out and faded where it passes under boxes

/**
 * Checks whether an edge is the one the sidebar is showing.
 * @param edge A visible edge.
 * @returns True if it's the selected arrow's edge.
 */
export function isSelectedEdge(edge: Edge): boolean {
    const selected = view.selectedEdge;
    return selected !== undefined && selected.from === edge.from && selected.to === edge.to && selected.kind === edge.kind;
}

// how each kind of arrow is counted in words: "1 import", "3 events"; and as a heading, like "Imports"
export interface KindWords {
    one: string;
    many: string;
    heading: string;
}
const KIND_WORDS: Record<EdgeKind, KindWords> = {
    import: { one: 'import', many: 'imports', heading: 'Imports' },
    event: { one: 'event', many: 'events', heading: 'Events' },
    message: { one: 'message', many: 'messages', heading: 'Messages' },
    flow: { one: 'step', many: 'steps', heading: 'Steps' },
};

// kinds of links that only happen when the code runs, like an event firing, rather than being part of its structure,
// like an import. They draw dashed, so they stand out from the structure; a new kind joins one family or the other
const RUNTIME_KINDS: EdgeKind[] = ['event', 'message'];

/**
 * Checks whether a kind of arrow is a link that only happens at runtime.
 * @param kind The kind.
 * @returns True for events and messages; false for imports.
 */
export function isRuntimeKind(kind: EdgeKind): boolean {
    return RUNTIME_KINDS.includes(kind);
}

/**
 * Finds the words for a kind of arrow.
 * @param kind The kind.
 * @returns How one and many are said, and its heading.
 */
export function kindWords(kind: EdgeKind): KindWords {
    return KIND_WORDS[kind];
}

/**
 * Says what an arrow stands for, on hover: how many of its kind, and for events and messages, their names, since the
 * name is what links the two ends.
 * @param edge The arrow's edge.
 * @returns Like "2 imports", or "2 events: saved, cleared".
 */
function arrowTitle(edge: VisibleEdge): string {
    const words = kindWords(edge.kind);
    let title = edge.count + ' ' + (edge.count === 1 ? words.one : words.many);
    const names: string[] = [];
    for (const graphEdge of edge.edges) {
        if (graphEdge.name !== undefined && !names.includes(graphEdge.name)) {
            names.push(graphEdge.name);
        }
    }
    if (names.length > 0) {
        title += ': ' + names.join(', ');
    }
    return title;
}

/**
 * Makes one arrow, in its own svg so it can paint at its own depth among the boxes.
 * @param arrow The arrow, from placeArrows, in page coordinates.
 * @param edge The edge it draws, so clicking it can select it, with how many of the graph's edges it stands for.
 * @param zIndex How high it paints, from arrowZIndex.
 * @param under The boxes it passes under, from boxesUnderArrow, in page coordinates; it's cut out where it crosses them.
 * @param faint True to draw it faintly, for an arrow that isn't the selected box's in the default arrow setting.
 * @param uncovered An area where nothing fades it, like a dragged box it's drawn on, which paints on top of the boxes
 *   around it; undefined for none.
 * @returns The svg element holding the arrow.
 */
export function makeArrow(arrow: Arrow, edge: VisibleEdge, zIndex: number, under: Rect[], faint: boolean, uncovered: Rect | undefined): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('arrow');

    // its kind, and whether it's a runtime link, which draws dashed; the page's styles read these
    svg.classList.add('arrow-' + edge.kind);
    if (isRuntimeKind(edge.kind)) {
        svg.classList.add('arrow-runtime');
    }

    // thicker the more links it stands for; the page's styles read this. Its head grows with it
    const lineWidth = arrowWidth(edge.count);
    const head = arrowHead(arrow, lineWidth);
    svg.style.setProperty('--arrow-width', lineWidth + 'px');
    if (isSelectedEdge(edge)) {
        svg.classList.add('selected');
    }
    if (faint) {
        svg.classList.add('faint');
    }
    svg.style.zIndex = String(zIndex);
    // the SVG needs a viewport around the whole curve; otherwise only the portion in its default 300x150 box
    // receives pointer events, even though overflow lets the rest of the curve remain visible
    const bounds = arrowBounds(arrow);
    svg.setAttribute('viewBox', bounds.x + ' ' + bounds.y + ' ' + bounds.width + ' ' + bounds.height);
    svg.setAttribute('width', String(bounds.width));
    svg.setAttribute('height', String(bounds.height));
    svg.style.left = bounds.x + 'px';
    svg.style.top = bounds.y + 'px';

    // it shows everywhere except over the boxes it passes under: its whole area, with a hole cut for each of them.
    // The clip also lets clicks there through to the box
    const arrowNumber = nextArrowId;
    nextArrowId++;
    const clipId = 'arrow-clip-' + arrowNumber;
    const defs = document.createElementNS(SVG_NS, 'defs');
    const clip = document.createElementNS(SVG_NS, 'clipPath');
    clip.id = clipId;
    const shape = document.createElementNS(SVG_NS, 'path');
    let d = rectPath(bounds);
    for (const rect of under) {
        d += ' ' + rectPath(rect);
    }
    shape.setAttribute('d', d);
    shape.setAttribute('clip-rule', 'evenodd'); // each rect inside the first is a hole
    clip.appendChild(shape);
    defs.appendChild(clip);

    // near those boxes it fades out first: a mask that shows everything, darkening in bands toward each box. Bands
    // overlap, so each one further in is darker. The clip still does the exact cut, and decides where clicks land
    const fadeId = 'arrow-fade-' + arrowNumber;
    const fade = document.createElementNS(SVG_NS, 'mask');
    fade.id = fadeId;
    fade.setAttribute('maskUnits', 'userSpaceOnUse');
    fade.setAttribute('x', String(bounds.x));
    fade.setAttribute('y', String(bounds.y));
    fade.setAttribute('width', String(bounds.width));
    fade.setAttribute('height', String(bounds.height));
    fade.appendChild(makeMaskRect(bounds, 0, 'white', 1));
    for (const rect of under) {
        for (let band = FADE_BANDS; band >= 1; band--) {
            fade.appendChild(makeMaskRect(rect, band * FADE_STEP, 'black', FADE_DARKEN));
        }
    }
    if (uncovered !== undefined) {
        // drawn last, so it shows the arrow in full there again
        fade.appendChild(makeMaskRect(uncovered, 0, 'white', 1));
    }
    defs.appendChild(fade);
    svg.appendChild(defs);

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('clip-path', 'url(#' + clipId + ')');
    group.setAttribute('mask', 'url(#' + fadeId + ')');
    svg.appendChild(group);

    const line = document.createElementNS(SVG_NS, 'path');
    line.classList.add('arrow-line');
    // the line stops at the head's base, 1px inside it so no gap shows, so a thick line can't show past the tip
    line.setAttribute('d', arrowPath(arrow, head.length - 1));
    group.appendChild(line);

    const headShape = document.createElementNS(SVG_NS, 'path');
    headShape.classList.add('arrow-head');
    headShape.setAttribute('d', head.path);
    group.appendChild(headShape);

    // a wide, invisible copy of the line on top of it, so a thin arrow is still easy to click
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.classList.add('arrow-hit');
    hit.setAttribute('d', arrowPath(arrow));
    function select(event: MouseEvent): void {
        event.stopPropagation();
        view.selectedEdge = edge;
        view.selectedId = undefined;
        redraw();
    }
    hit.addEventListener('click', select);

    // what it stands for, on hover
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = arrowTitle(edge);
    hit.appendChild(title);
    group.appendChild(hit);

    return svg;
}

// numbers each arrow's clip and fade shapes, so their ids don't clash; reset on every redraw
let nextArrowId = 0;

// near a box it passes under, an arrow fades out over this many bands, each this wide, each this much darker, so it
// doesn't look like it starts or ends at that box
export const FADE_BANDS = 4;
export const FADE_STEP = 4;
const FADE_DARKEN = 0.3;

/**
 * Makes one rectangle of an arrow's fade mask: a box grown on every side, with its corners rounded to match.
 * @param rect The box, in page coordinates.
 * @param grow How far to grow it on each side.
 * @param color 'white' to show the arrow there, 'black' to hide it.
 * @param opacity How strongly it shows or hides.
 * @returns The svg rect.
 */
function makeMaskRect(rect: Rect, grow: number, color: string, opacity: number): SVGRectElement {
    const shape = document.createElementNS(SVG_NS, 'rect');
    shape.setAttribute('x', String(rect.x - grow));
    shape.setAttribute('y', String(rect.y - grow));
    shape.setAttribute('width', String(rect.width + grow * 2));
    shape.setAttribute('height', String(rect.height + grow * 2));
    shape.setAttribute('rx', String(8 + grow)); // boxes have 8px corners
    shape.setAttribute('fill', color);
    shape.setAttribute('fill-opacity', String(opacity));
    return shape;
}

/**
 * Writes a rectangle as svg path data.
 * @param rect The rectangle.
 * @returns A closed path around it.
 */
function rectPath(rect: Rect): string {
    return 'M ' + rect.x + ' ' + rect.y + ' h ' + rect.width + ' v ' + rect.height + ' h ' + (-rect.width) + ' Z';
}

/**
 * Starts numbering arrows from 0 again, at the start of a redraw.
 */
export function resetArrowIds(): void {
    nextArrowId = 0;
}
