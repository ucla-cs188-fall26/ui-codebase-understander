import { ROOT_ID } from '../graph/types';
import { ExtensionToWebview, WebviewToExtension } from '../messages';
import { GAP } from '../layout/defaultLayout';
import { Arrow, arrowPath, placeArrows } from '../layout/arrows';
import { Camera, zoomAt } from '../layout/camera';
import { nodeSize } from '../layout/size';
import { Position } from '../layout/geometry';
import { buildGraphInfo, closeNode, createLayoutState, GraphInfo, LayoutState, openNode, shownChildren } from '../layout/state';
import { arrowZIndex, boxZIndexes, placeBoxes, visibleEdges } from '../layout/place';

// VS Code provides this once per webview; calling it a second time throws
declare function acquireVsCodeApi(): { postMessage(message: WebviewToExtension): void };
const vscode = acquireVsCodeApi();

// margin between the panel's top-left corner and the layout
const START_X = 40;
const START_Y = 40;

/**
 * Makes one box element.
 * @param label The text inside the box.
 * @param kind A class for styling: 'repo', 'folder', 'file', or 'more'.
 * @param x The left edge, in pixels.
 * @param y The top edge, in pixels.
 * @param width The width, in pixels.
 * @param height The height, in pixels.
 * @returns The element, absolutely positioned. Not on the page until someone appends it.
 */
function makeBox(label: string, kind: string, x: number, y: number, width: number, height: number): HTMLElement {
	const box = document.createElement('div');
	box.className = 'box ' + kind;
	box.style.left = x + 'px';
	box.style.top = y + 'px';
	box.style.width = width + 'px';
	box.style.height = height + 'px';

	const text = document.createElement('span');
	text.className = 'label';
	text.textContent = label;
	box.appendChild(text);

	return box;
}

// SVG elements need this namespace, or the browser treats them as unknown HTML tags
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Makes the arrowhead shape every arrow points with. Arrows anywhere on the page can use it as url(#arrowhead).
 * @returns An invisible svg element holding the shape.
 */
function makeArrowheadDefs(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.id = 'arrowheads';

	const defs = document.createElementNS(SVG_NS, 'defs');
	const marker = document.createElementNS(SVG_NS, 'marker');
	marker.id = 'arrowhead';
	marker.setAttribute('viewBox', '0 0 10 10');
	marker.setAttribute('refX', '10'); // the triangle's tip sits on the arrow's end
	marker.setAttribute('refY', '5');
	marker.setAttribute('markerWidth', '6');
	marker.setAttribute('markerHeight', '6');
	marker.setAttribute('orient', 'auto'); // turn to follow the curve's direction
	const triangle = document.createElementNS(SVG_NS, 'path');
	triangle.setAttribute('d', 'M 0 0 L 10 5 L 0 10 Z');
	marker.appendChild(triangle);
	defs.appendChild(marker);
	svg.appendChild(defs);

	return svg;
}

/**
 * Makes one arrow, in its own svg so it can paint at its own depth among the boxes.
 * @param arrow The arrow, from placeArrows, in page coordinates.
 * @param zIndex How high it paints, from arrowZIndex.
 * @returns The svg element holding the arrow.
 */
function makeArrow(arrow: Arrow, zIndex: number): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.classList.add('arrow');
	svg.style.zIndex = String(zIndex);

	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', arrowPath(arrow));
	path.setAttribute('marker-end', 'url(#arrowhead)');
	svg.appendChild(path);

	return svg;
}

/**
 * Counts the children a box keeps behind "+N more".
 * @param info The graph lookups.
 * @param id The box.
 * @returns How many of its children have no box of their own.
 */
function hiddenCount(info: GraphInfo, id: string): number {
	const children = info.childrenById.get(id) ?? [];
	return children.length - shownChildren(info, id).length;
}

/**
 * Draws every visible box and arrow from the current state, replacing whatever was drawn before.
 */
function drawGraph(): void {
	if (info === undefined) {
		return;
	}

	const rects = placeBoxes(state, info, { x: START_X, y: START_Y });

	const world = document.getElementById('world')!;
	world.replaceChildren();

	// paint order: each box gets a z-index, and each arrow sits just above the open boxes holding its ends
	const boxZ = boxZIndexes(rects);
	world.appendChild(makeArrowheadDefs());
	const edges = visibleEdges(state, info, rects);
	const arrows = placeArrows(edges, rects);
	for (let i = 0; i < arrows.length; i++) {
		// placeArrows keeps the edges' order, so arrows[i] belongs to edges[i]
		world.appendChild(makeArrow(arrows[i], arrowZIndex(edges[i], state, info, boxZ)));
	}

	for (const [id, rect] of rects) {
		const node = info.nodesById.get(id)!;
		const isOpen = state.expanded.has(id);

		// an open box shows how many children it is hiding next to its name
		let label = node.name;
		const hidden = hiddenCount(info, id);
		if (isOpen && hidden > 0) {
			label += ' · +' + hidden + ' more';
		}

		const kind = isOpen ? node.kind + ' open' : node.kind;
		const box = makeBox(label, kind, rect.x, rect.y, rect.width, rect.height);

		// so a click can tell which node it landed on
		box.dataset.id = id;
		box.style.zIndex = String(boxZ.get(id));

		if (id === selectedId) {
			box.classList.add('selected');
		}

		// anything that can hold children gets an arrow to open or close it
		if (node.kind !== 'file') {
			const chevron = document.createElement('span');
			chevron.className = 'chevron';
			chevron.textContent = isOpen ? '▾' : '▸';
			box.prepend(chevron);
		}

		world.appendChild(box);
	}

	// the root has no box to show a count in, so its "+N more" sits below everything
	const rootHidden = hiddenCount(info, ROOT_ID);
	if (rootHidden > 0) {
		let bottom = START_Y;
		for (const rect of rects.values()) {
			bottom = Math.max(bottom, rect.y + rect.height);
		}

		const size = nodeSize(0, 0);
		world.appendChild(makeBox('+' + rootHidden + ' more', 'more', START_X, bottom + GAP, size.width, size.height));
	}
}

// the current graph's lookups, and what's open and where; undefined until a graph arrives
let info: GraphInfo | undefined = undefined;
let state: LayoutState = createLayoutState();

// the node whose details the sidebar shows, or undefined when nothing is selected
let selectedId: string | undefined = undefined;

// how the world is shown; kept between redraws so new data doesn't reset the view
let camera: Camera = { x: 0, y: 0, scale: 1 };

// how strongly one wheel step zooms; small, because trackpads send many tiny steps
const ZOOM_SPEED = 0.005;

/**
 * Moves and scales the whole world to match the camera.
 */
function applyCamera(): void {
	const world = document.getElementById('world')!;
	world.style.transform = 'translate(' + camera.x + 'px, ' + camera.y + 'px) scale(' + camera.scale + ')';
}

/**
 * Zooms around the mouse. Scrolling is always zoom, never page scroll.
 * @param event The browser's wheel event.
 */
function handleWheel(event: WheelEvent): void {
	event.preventDefault();

	// scrolling up (negative deltaY) zooms in; exp keeps big and tiny steps both smooth
	const factor = Math.exp(-event.deltaY * ZOOM_SPEED);
	camera = zoomAt(camera, { x: event.clientX, y: event.clientY }, factor);
	applyCamera();
}

// where the mouse was at the last move while panning, or undefined when not panning
let panLast: Position | undefined = undefined;

// where the latest press started, so a click that was really a drag can be ignored
let pressStart: Position = { x: 0, y: 0 };

// how far the mouse may move between press and release and still count as a click, in pixels
const CLICK_SLOP = 4;

/**
 * Starts panning when the press lands on empty space, not on a box.
 * @param event The browser's pointer event.
 */
function handlePointerDown(event: PointerEvent): void {
	pressStart = { x: event.clientX, y: event.clientY };

	const target = event.target as Element;
	if (target.closest('.box') !== null) {
		return;
	}

	panLast = { x: event.clientX, y: event.clientY };

	// keep receiving moves even if the mouse leaves the panel mid-drag
	document.body.setPointerCapture(event.pointerId);
	document.body.classList.add('panning');
}

/**
 * Moves the world along with the mouse while panning.
 * @param event The browser's pointer event.
 */
function handlePointerMove(event: PointerEvent): void {
	if (panLast === undefined) {
		return;
	}

	camera = { x: camera.x + event.clientX - panLast.x, y: camera.y + event.clientY - panLast.y, scale: camera.scale };
	panLast = { x: event.clientX, y: event.clientY };
	applyCamera();
}

/**
 * Stops panning.
 */
function handlePointerUp(): void {
	panLast = undefined;
	document.body.classList.remove('panning');
}

/**
 * Handles a click: the arrow on a box opens or closes it, anywhere else on a box selects it,
 * and empty space clears the selection.
 * @param event The browser's mouse event.
 */
function handleClick(event: MouseEvent): void {
	if (info === undefined) {
		return;
	}

	// moved too far: this was a drag, not a click
	const moved = Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y);
	if (moved > CLICK_SLOP) {
		return;
	}

	const target = event.target as Element;
	const box = target.closest<HTMLElement>('.box');
	const id = box?.dataset.id;

	// empty space, or the "+N more" box, which has no node
	if (id === undefined) {
		selectedId = undefined;
	} else if (target.closest('.chevron') !== null) {
		if (state.expanded.has(id)) {
			closeNode(state, id);
		} else {
			openNode(state, info, id);
		}
	} else {
		selectedId = id;
	}

	drawGraph();
}

/**
 * Handles a message from the extension.
 * @param event The browser's message event. Its data is what the extension posted.
 */
function handleMessage(event: MessageEvent<ExtensionToWebview>): void {
	if (event.data.type === 'graph') {
		info = buildGraphInfo(event.data.graph);

		// a fresh view each time for now; saved layouts come later
		state = createLayoutState();
		openNode(state, info, ROOT_ID);

		drawGraph();
	}
}

// listen first, then ask, so the reply can't arrive before anyone is listening
window.addEventListener('message', handleMessage);

// passive: false, or the browser ignores preventDefault on wheel events
window.addEventListener('wheel', handleWheel, { passive: false });

document.body.addEventListener('pointerdown', handlePointerDown);
document.body.addEventListener('pointermove', handlePointerMove);
document.body.addEventListener('pointerup', handlePointerUp);
document.body.addEventListener('click', handleClick);
vscode.postMessage({ type: 'ready' });
