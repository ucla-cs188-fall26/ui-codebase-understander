import { NodeKind, ROOT_ID } from '../graph/types';
import { ExtensionToWebview, WebviewToExtension } from '../messages';
import { connections } from '../analysis/edges';
import { getLineage, groupByParent } from '../analysis/lookups';
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

	// keep the sidebar in step with the selection
	drawSidebar();
}

// the current graph's lookups, and what's open and where; undefined until a graph arrives
let info: GraphInfo | undefined = undefined;
let state: LayoutState = createLayoutState();

// the node whose details the sidebar shows, or undefined when nothing is selected
let selectedId: string | undefined = undefined;

/**
 * Shows the selected node's details in the sidebar, or hides the sidebar when nothing is selected.
 */
function drawSidebar(): void {
	const sidebar = document.getElementById('sidebar')!;
	if (info === undefined || selectedId === undefined) {
		sidebar.classList.remove('visible');
		return;
	}

	const node = info.nodesById.get(selectedId)!;
	sidebar.replaceChildren();

	const header = document.createElement('div');
	header.className = 'sidebar-header';
	const name = document.createElement('span');
	name.textContent = node.name;
	header.appendChild(name);

	const close = document.createElement('button');
	close.className = 'icon-button sidebar-close';
	close.title = 'Close';
	close.appendChild(makeCloseIcon());
	close.addEventListener('click', handleSidebarClose);
	header.appendChild(close);

	sidebar.appendChild(header);

	const pathRow = addDetail(sidebar, 'Path', node.path);
	pathRow.querySelector('.sidebar-value')!.replaceChildren(pathWithBreaks(node.path));
	pathRow.appendChild(makeOpenButton(node.path, node.kind));
	addDetail(sidebar, 'Kind', node.kind);
	if (node.kind !== 'file') {
		addDetail(sidebar, 'Children', String(node.childCount));
	}
	addDetail(sidebar, 'Times imported', String(info.indegrees.get(selectedId)));

	const linked = connections(selectedId, info.edges, info.nodesById);
	addConnectionList(sidebar, 'Imports', linked.outgoing);
	addConnectionList(sidebar, 'Imported by', linked.incoming);

	sidebar.classList.add('visible');
}

/**
 * Adds one "label: value" row to the sidebar.
 * @param sidebar The sidebar element.
 * @param label What the value is.
 * @param value The value.
 * @returns The row, so more can be added to it.
 */
function addDetail(sidebar: HTMLElement, label: string, value: string): HTMLElement {
	const row = document.createElement('div');
	row.className = 'sidebar-row';

	const labelElement = document.createElement('span');
	labelElement.className = 'sidebar-label';
	labelElement.textContent = label;
	row.appendChild(labelElement);

	const valueElement = document.createElement('span');
	valueElement.className = 'sidebar-value';
	valueElement.textContent = value;
	row.appendChild(valueElement);

	sidebar.appendChild(row);
	return row;
}

/**
 * Writes a path so that, when it has to wrap, it wraps after a slash rather than mid-name.
 * @param path A path like tests/integration/admin.test.js.
 * @returns The path's text with a line-break opportunity (a wbr element) after each slash.
 */
function pathWithBreaks(path: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	const parts = path.split('/');
	for (let i = 0; i < parts.length; i++) {
		const isLast = i === parts.length - 1;
		fragment.append(isLast ? parts[i] : parts[i] + '/');
		if (!isLast) {
			fragment.append(document.createElement('wbr'));
		}
	}
	return fragment;
}

/**
 * Draws an arrow pointing up and right, the usual sign for "open elsewhere".
 * @returns A 16×16 svg.
 */
function makeOpenIcon(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('viewBox', '0 0 16 16');

	// the arrow's corner, then its shaft
	const lines = document.createElementNS(SVG_NS, 'path');
	lines.setAttribute('d', 'M 6 4 H 12 V 10 M 12 4 L 4 12');
	svg.appendChild(lines);

	return svg;
}

/**
 * Makes a button that opens a file in the editor, or shows a folder in the Explorer.
 * @param path The node's repo-relative path.
 * @param kind The node's kind, which decides what opening means.
 * @returns The button.
 */
function makeOpenButton(path: string, kind: NodeKind): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = 'icon-button';
	button.title = kind === 'file' ? 'Open in editor' : 'Show in Explorer';
	button.dataset.path = path;
	button.dataset.kind = kind;
	button.appendChild(makeOpenIcon());
	button.addEventListener('click', handleOpenClick);
	return button;
}

/**
 * Asks the extension to open what an open button stands for.
 * @param event The browser's mouse event. Its currentTarget is the button, which carries the path and kind.
 */
function handleOpenClick(event: MouseEvent): void {
	// only open: don't also select the row it sits in
	event.stopPropagation();

	const button = event.currentTarget as HTMLElement;
	vscode.postMessage({ type: 'open', path: button.dataset.path!, kind: button.dataset.kind as NodeKind });
}

/**
 * Adds a titled list of nodes to the sidebar; clicking one selects it.
 * @param sidebar The sidebar element.
 * @param title The section title.
 * @param ids The nodes to list.
 */
function addConnectionList(sidebar: HTMLElement, title: string, ids: string[]): void {
	const heading = document.createElement('div');
	heading.className = 'sidebar-section';
	heading.textContent = title;
	sidebar.appendChild(heading);

	if (ids.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'sidebar-empty';
		empty.textContent = 'None';
		sidebar.appendChild(empty);
		return;
	}

	// folder by folder: each folder as a heading you can jump to, then its files by name
	for (const [parentId, childIds] of groupByParent(ids, info!.nodesById)) {
		// files at the top of the repo have no folder, so they get no heading and no indent
		const isTopLevel = parentId === ROOT_ID;
		if (!isTopLevel) {
			sidebar.appendChild(makeLinkRow(parentId, parentId + '/', 'sidebar-folder'));
		}

		for (const id of childIds) {
			const rowClass = isTopLevel ? '' : 'sidebar-indented';
			sidebar.appendChild(makeLinkRow(id, info!.nodesById.get(id)!.name, rowClass));
		}
	}
}

/**
 * Makes one sidebar row that jumps to a node when clicked, with a button to open it.
 * @param id The node.
 * @param text What the row says.
 * @param extraClass A class for how the row looks, like a folder heading or an indented file.
 * @returns The row.
 */
function makeLinkRow(id: string, text: string, extraClass: string): HTMLElement {
	const link = document.createElement('div');
	link.className = 'sidebar-link ' + extraClass;
	link.title = id; // the full path on hover
	link.dataset.id = id;
	link.addEventListener('click', handleConnectionClick);

	const textElement = document.createElement('span');
	textElement.className = 'sidebar-link-text';
	textElement.textContent = text;
	link.appendChild(textElement);

	const node = info!.nodesById.get(id)!;
	link.appendChild(makeOpenButton(node.path, node.kind));

	return link;
}

/**
 * Selects the node a sidebar row names, opening the boxes around it so it can be seen.
 * @param event The browser's mouse event. Its currentTarget is the row, which carries the node's id.
 */
function handleConnectionClick(event: MouseEvent): void {
	// redrawing removes this row from the page, so the body's click handler would mistake it for empty space
	event.stopPropagation();

	const id = (event.currentTarget as HTMLElement).dataset.id!;
	revealNode(id);
	selectedId = id;
	drawGraph();
	centerOn(id);
}

// room the sidebar card takes on the right, so centering aims at the part of the graph you can see
const SIDEBAR_SPACE = 280 + 24;

// how long the view takes to glide to a box, in milliseconds; matches the transition in the page's CSS
const GLIDE_TIME = 300;

/**
 * Moves the view so a box sits in the middle of the visible area, keeping the zoom.
 * @param id The box to bring into view. Does nothing if it has no box, like a node behind "+N more".
 */
function centerOn(id: string): void {
	const box = document.querySelector<HTMLElement>('.box[data-id="' + CSS.escape(id) + '"]');
	if (box === null) {
		return;
	}

	// offset values are in world pixels, before the camera's transform
	const boxCenterX = box.offsetLeft + box.offsetWidth / 2;
	const boxCenterY = box.offsetTop + box.offsetHeight / 2;

	const middleX = (window.innerWidth - SIDEBAR_SPACE) / 2;
	const middleY = window.innerHeight / 2;

	camera = { x: middleX - boxCenterX * camera.scale, y: middleY - boxCenterY * camera.scale, scale: camera.scale };

	// glide there, then switch the transition off so panning by hand stays instant
	document.getElementById('world')!.classList.add('gliding');
	applyCamera();
	setTimeout(stopGliding, GLIDE_TIME);
}

/**
 * Turns off the glide animation after centerOn.
 */
function stopGliding(): void {
	document.getElementById('world')!.classList.remove('gliding');
}

/**
 * Opens every box containing a node, from the top down, so the node gets a box of its own.
 * A node behind "+N more" still won't have one until strips exist.
 * @param id The node to reveal.
 */
function revealNode(id: string): void {
	if (info === undefined) {
		return;
	}

	// the lineage runs from the node up to the root; open from the root down, skipping the node itself
	const lineage = getLineage(id, info.nodesById);
	for (let i = lineage.length - 1; i >= 1; i--) {
		openNode(state, info, lineage[i]);
	}
}

/**
 * Draws an X as two crossing lines, so it is symmetric whatever the font.
 * @returns A 16×16 svg.
 */
function makeCloseIcon(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('viewBox', '0 0 16 16');

	const lines = document.createElementNS(SVG_NS, 'path');
	lines.setAttribute('d', 'M 4 4 L 12 12 M 12 4 L 4 12');
	svg.appendChild(lines);

	return svg;
}

/**
 * Clears the selection, which hides the sidebar.
 */
function handleSidebarClose(): void {
	selectedId = undefined;
	drawGraph();
}

/**
 * Checks whether an event happened inside the sidebar, which handles its own clicks and scrolling.
 * @param event Any browser event.
 * @returns True if its target is in the sidebar.
 */
function isInSidebar(event: Event): boolean {
	return (event.target as Element).closest('#sidebar') !== null;
}

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
	// let the sidebar scroll its own lists
	if (isInSidebar(event)) {
		return;
	}
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
	if (target.closest('.box') !== null || isInSidebar(event)) {
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
	if (info === undefined || isInSidebar(event)) {
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
