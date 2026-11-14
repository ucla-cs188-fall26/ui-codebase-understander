import { Edge, Node, NodeKind, ROOT_ID } from '../graph/types';
import { ExtensionToWebview, FlowGraphMessage, FlowScenario, ModelOption, WebviewToExtension } from '../messages';
import { connections, isInside } from '../analysis/edges';
import { getLineage, groupByParent } from '../analysis/lookups';
import { Arrow, arrowHead, arrowPath, arrowWidth, placeArrows } from '../layout/arrows';
import { Camera, fitCamera, zoomAt } from '../layout/camera';
import { boundsOf, Position, Rect, Size } from '../layout/geometry';
import { arrangeShown, boxSize, buildGraphInfo, closeNode, copyLayoutState, createLayoutState, GraphInfo, layOutChildren, LayoutState, openNode, resetNode, resizeTo, showMoreFromStrip } from '../layout/state';
import { ArrowMode, fromSaved, toSaved } from '../layout/saved';
import { dragTo, dropAt } from '../layout/drop';
import { makeArrowsIcon, makeCloseIcon, makeFitIcon, makeGripIcon, makeOpenIcon, makeResetIcon, makeResizeIcon, makeSettingsIcon, SVG_NS } from './icons';
import { arrowEndsOf, arrowTouches, arrowZIndex, boxesUnderArrow, boxZIndexes, nodeOfEnd, placeBoxes, placeStrips, Strip, VisibleEdge, visibleEdges } from '../layout/place';

// VS Code provides this once per webview; calling it a second time throws
declare function acquireVsCodeApi(): { postMessage(message: WebviewToExtension): void };
const vscode = acquireVsCodeApi();

// margin between the panel's top-left corner and the layout
const START_X = 40;
const START_Y = 40;

// added to the z-index of a dragged box and everything inside it, so they paint above every other box and arrow
const DRAG_RAISE = 100000;

/**
 * Makes one box element.
 * @param label The text inside the box.
 * @param kind A class for styling: 'repo', 'directory', or 'file'.
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

	// the title: all of a closed box, the strip across the top of an open one; it's where you grab a box to move it
	const title = document.createElement('div');
	title.className = 'box-title';
	box.appendChild(title);

	const text = document.createElement('span');
	text.className = 'label';
	text.textContent = label;
	title.appendChild(text);

	return box;
}

/**
 * Checks whether an edge is the one the sidebar is showing.
 * @param edge A visible edge.
 * @returns True if it's the selected arrow's edge.
 */
function isSelectedEdge(edge: Edge): boolean {
	return selectedEdge !== undefined && selectedEdge.from === edge.from && selectedEdge.to === edge.to;
}

/**
 * Makes one arrow, in its own svg so it can paint at its own depth among the boxes.
 * @param arrow The arrow, from placeArrows, in page coordinates.
 * @param edge The edge it draws, so clicking it can select it, with how many of the graph's edges it stands for.
 * @param zIndex How high it paints, from arrowZIndex.
 * @param under The boxes it passes under, from boxesUnderArrow, in page coordinates; it's cut out where it crosses them.
 * @param faint True to draw it faintly, for an arrow that isn't the selected box's in the default arrow setting.
 * @returns The svg element holding the arrow.
 */
function makeArrow(arrow: Arrow, edge: VisibleEdge, zIndex: number, under: Rect[], faint: boolean): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.classList.add('arrow');

	// thicker the more imports it stands for; the page's styles read this. Its head grows with it
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
	// The SVG needs a viewport around the whole curve; otherwise only the portion in its default 300x150 box
	// receives pointer events, even though overflow lets the rest of the curve remain visible.
	// The extra 6 is half the click target's width, so its edges aren't cut off.
	const pull = Math.max(30, Math.hypot(arrow.end.x - arrow.start.x, arrow.end.y - arrow.start.y) / 2) + 6;
	const left = Math.min(arrow.start.x, arrow.end.x) - pull;
	const top = Math.min(arrow.start.y, arrow.end.y) - pull;
	const width = Math.abs(arrow.end.x - arrow.start.x) + pull * 2;
	const height = Math.abs(arrow.end.y - arrow.start.y) + pull * 2;
	svg.setAttribute('viewBox', left + ' ' + top + ' ' + width + ' ' + height);
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	svg.style.left = left + 'px';
	svg.style.top = top + 'px';

	// it shows everywhere except over the boxes it passes under: its whole area, with a hole cut for each of them.
	// The clip also lets clicks there through to the box
	const arrowNumber = nextArrowId;
	nextArrowId++;
	const clipId = 'arrow-clip-' + arrowNumber;
	const defs = document.createElementNS(SVG_NS, 'defs');
	const clip = document.createElementNS(SVG_NS, 'clipPath');
	clip.id = clipId;
	const shape = document.createElementNS(SVG_NS, 'path');
	let d = rectPath({ x: left, y: top, width: width, height: height });
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
	fade.setAttribute('x', String(left));
	fade.setAttribute('y', String(top));
	fade.setAttribute('width', String(width));
	fade.setAttribute('height', String(height));
	fade.appendChild(makeMaskRect({ x: left, y: top, width: width, height: height }, 0, 'white', 1));
	for (const rect of under) {
		for (let band = FADE_BANDS; band >= 1; band--) {
			fade.appendChild(makeMaskRect(rect, band * FADE_STEP, 'black', FADE_DARKEN));
		}
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
		selectedEdge = edge;
		selectedId = undefined;
		drawGraph();
	}
	hit.addEventListener('click', select);

	// how many imports it stands for, on hover
	const title = document.createElementNS(SVG_NS, 'title');
	title.textContent = edge.count === 1 ? '1 import' : edge.count + ' imports';
	hit.appendChild(title);
	group.appendChild(hit);

	return svg;
}

// numbers each arrow's clip and fade shapes, so their ids don't clash; reset on every redraw
let nextArrowId = 0;

// near a box it passes under, an arrow fades out over this many bands, each this wide, each this much darker, so it
// doesn't look like it starts or ends at that box
const FADE_BANDS = 4;
const FADE_STEP = 4;
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
 * While dragging, checks whether one of the dragged box's own arrows has its other end under the box, so it would be
 * a stub pointing back into the box it comes from. Arrows between other boxes are always drawn; where they end under
 * the dragged box, they pass beneath it, since it paints on top.
 * @param arrow The placed arrow.
 * @param rects Every box's rect, with the dragged box already moved by the drag.
 * @returns True if one end is the dragged box (or inside it) and the other is under it; always false when nothing is
 *   dragged.
 */
function endsUnderDraggedBox(arrow: Arrow, rects: Map<string, Rect>): boolean {
	if (!isDragging || drag === undefined || info === undefined) {
		return false;
	}

	const dragged = rects.get(drag.id)!;
	function isUnderDraggedBox(point: Position): boolean {
		return point.x > dragged.x && point.x < dragged.x + dragged.width && point.y > dragged.y && point.y < dragged.y + dragged.height;
	}

	// an end that belongs to the dragged box (or something in it, strips included) moves with it, so it's never
	// hidden by it
	const fromDragged = isInside(nodeOfEnd(arrow.from), drag.id, info.nodesById);
	const toDragged = isInside(nodeOfEnd(arrow.to), drag.id, info.nodesById);

	// only the dragged box's own arrows to the outside can turn into stubs; arrows between other boxes pass under it,
	// and arrows inside it move with it
	if (fromDragged === toDragged) {
		return false;
	}
	const startHidden = !fromDragged && isUnderDraggedBox(arrow.start);
	const endHidden = !toDragged && isUnderDraggedBox(arrow.end);
	return startHidden || endHidden;
}

/**
 * Makes one "+N" strip, standing in for the children its box is hiding on that side.
 * @param strip The strip, from placeStrips.
 * @param zIndex How high it paints: just above its box.
 * @returns The element.
 */
function makeStrip(strip: Strip, zIndex: number): HTMLElement {
	const element = document.createElement('div');
	element.className = 'strip strip-' + strip.side;
	element.dataset.ownerId = strip.ownerId;
	element.dataset.side = strip.side;
	element.style.left = strip.rect.x + 'px';
	element.style.top = strip.rect.y + 'px';
	element.style.width = strip.rect.width + 'px';
	element.style.height = strip.rect.height + 'px';
	element.style.zIndex = String(zIndex);
	element.textContent = '+' + strip.hiddenIds.length;

	// the hidden names on hover
	const names: string[] = [];
	for (const id of strip.hiddenIds) {
		names.push(info!.nodesById.get(id)!.name);
	}
	element.title = names.join('\n');

	return element;
}

/**
 * Draws every visible box and arrow from the current state, replacing whatever was drawn before.
 */
function drawGraph(): void {
	if (info === undefined) {
		return;
	}

	const rects = placeBoxes(state, info, { x: START_X, y: START_Y });
	lastRects = rects;

	const world = document.getElementById('world')!;
	world.replaceChildren();

	// paint order: each box gets a z-index, and each arrow sits just above the open boxes holding its ends
	const boxZ = boxZIndexes(rects);

	// while dragging, the box and everything inside it paint above the rest as one unit
	if (isDragging && drag !== undefined) {
		for (const [id, z] of boxZ) {
			if (isInside(id, drag.id, info.nodesById)) {
				boxZ.set(id, z + DRAG_RAISE);
			}
		}
	}

	// strips stand in for hidden children; arrows to those end at the strip, so it goes in with the box rects
	const strips = placeStrips(state, info, rects);
	const arrowRects = new Map(rects);
	for (const strip of strips) {
		arrowRects.set(strip.id, strip.rect);
		world.appendChild(makeStrip(strip, (boxZ.get(strip.ownerId) ?? 0) + 1));
	}

	const edges = visibleEdges(state, info, rects, strips, arrowDepth);
	const arrows = placeArrows(edges, arrowRects);

	nextArrowId = 0;
	for (let i = 0; i < arrows.length; i++) {
		// while dragging, the dragged box's own arrow to something under it would be a stub pointing back into it
		if (endsUnderDraggedBox(arrows[i], rects)) {
			continue;
		}

		// placeArrows keeps the edges' order, so arrows[i] belongs to edges[i]

		// the selected box's arrows, and a selected arrow, always draw in full; the rest go by the toolbar setting
		const lit = isSelectedEdge(edges[i]) || (selectedId !== undefined && arrowTouches(edges[i], selectedId, info));
		if (!lit && arrowMode === 'hidden') {
			continue;
		}
		const faint = !lit && arrowMode === 'default';

		const under: Rect[] = [];
		for (const id of boxesUnderArrow(edges[i], info, rects)) {
			under.push(rects.get(id)!);
		}
		world.appendChild(makeArrow(arrows[i], edges[i], arrowZIndex(edges[i], state, info, boxZ), under, faint));
	}

	for (const [id, rect] of rects) {
		const node = info.nodesById.get(id)!;
		const isOpen = state.expanded.has(id);
		const kind = isOpen ? node.kind + ' open' : node.kind;
		const box = makeBox(node.name, kind, rect.x, rect.y, rect.width, rect.height);

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
			box.querySelector('.box-title')!.prepend(chevron);
		}

		// a grip at the title's right end, so it's clear the title is where to grab the box
		const grip = document.createElement('span');
		grip.className = 'grip';
		grip.appendChild(makeGripIcon());
		box.querySelector('.box-title')!.appendChild(grip);

		// only the selected box can be resized, the same as moving
		if (id === selectedId) {
			const handle = document.createElement('span');
			handle.className = 'resize-handle';
			handle.appendChild(makeResizeIcon());
			box.appendChild(handle);
		}

		world.appendChild(box);
	}

	// keep the sidebar in step with the selection
	drawSidebar();

	// whatever changed, store it for next time
	scheduleSave();
}

/** Draws a flow as a left-to-right sequence, reusing the graph's node boxes and arrow renderer. */
function drawFlowGraph(view: FlowGraphMessage): void {
	flowView = view;
	info = undefined;
	const toolbar = document.getElementById('toolbar')!;
	toolbar.replaceChildren();
	const title = document.createElement('strong');
	title.className = 'flow-view-title';
	title.textContent = view.flow.title;
	toolbar.appendChild(title);
	const fit = document.createElement('button');
	fit.className = 'icon-button';
	fit.title = 'Fit flow to view';
	fit.appendChild(makeFitIcon());
	fit.addEventListener('click', fitToView);
	toolbar.appendChild(fit);

	const description = document.getElementById('flow-description')!;
	description.replaceChildren();
	const summary = document.createElement('div');
	summary.textContent = view.flow.summary;
	description.appendChild(summary);
	const entry = document.createElement('small');
	entry.textContent = 'Entry point: ' + view.flow.entryNodeId;
	description.appendChild(entry);
	description.classList.add('visible');
	document.getElementById('flow-results')!.classList.remove('visible');
	document.getElementById('sidebar')!.classList.remove('visible');

	const world = document.getElementById('world')!;
	world.replaceChildren();
	const rects = new Map<string, Rect>();
	const actions = new Map(view.flow.steps.map((step) => [step.nodeId, step.action]));
	const boxWidth = 280;
	const boxHeight = 112;
	const gap = 110;
	const y = Math.max(100, window.innerHeight / 2 - boxHeight / 2);
	view.graph.nodes.forEach((node, index) => {
		rects.set(node.id, { x: 40 + index * (boxWidth + gap), y: y, width: boxWidth, height: boxHeight });
	});
	const arrows = placeArrows(view.graph.edges, rects);
	for (let i = 0; i < arrows.length; i++) {
		// the flow's boxes sit in one row, so no arrow passes under any
		const flowEdge = view.graph.edges[i];
		world.appendChild(makeArrow(arrows[i], { from: flowEdge.from, to: flowEdge.to, kind: flowEdge.kind, count: 1, edges: [flowEdge] }, 1, [], false));
	}
	view.graph.nodes.forEach((node: Node, index) => {
		const rect = rects.get(node.id)!;
		const box = makeBox(node.name, node.kind, rect.x, rect.y, rect.width, rect.height);
		box.classList.add('flow-node');
		box.dataset.id = node.id;
		box.dataset.path = node.path;
		box.style.zIndex = '2';
		const path = document.createElement('div');
		path.className = 'flow-node-path';
		path.textContent = node.path;
		box.appendChild(path);
		const action = document.createElement('div');
		action.className = 'flow-step-action';
		action.textContent = (index + 1) + '. ' + (actions.get(node.id) ?? '');
		box.appendChild(action);
		world.appendChild(box);
	});
	lastRects = rects;
	const bounds = boundsOf(rects.values());
	if (bounds !== undefined) {
		camera = fitCamera(bounds, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, FIT_MARGIN);
		applyCamera();
	}
}

// the current graph's lookups, and what's open and where; undefined until a graph arrives
let info: GraphInfo | undefined = undefined;
let state: LayoutState = createLayoutState();

// the node whose details the sidebar shows, or undefined when nothing is selected
let selectedId: string | undefined = undefined;
let selectedEdge: Edge | undefined = undefined;
let flowView: FlowGraphMessage | undefined;

// every box drawn last time, so Fit to view can measure what's on screen
let lastRects = new Map<string, Rect>();

/**
 * Shows the selected node's details in the sidebar, or hides the sidebar when nothing is selected.
 */
function drawSidebar(): void {
	const sidebar = document.getElementById('sidebar')!;
	if (info === undefined || (selectedId === undefined && selectedEdge === undefined)) {
		sidebar.classList.remove('visible');
		return;
	}
	if (selectedEdge !== undefined) {
		drawEdgeSidebar(sidebar, selectedEdge);
		return;
	}

	const node = info.nodesById.get(selectedId!)!;
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

	// what you can do with this node, before the details you read
	const actions = document.createElement('div');
	actions.className = 'sidebar-actions';

	// short labels so both buttons fit on one line; the tooltip says it in full
	const open = makeTextButton(makeOpenIcon(), node.kind === 'file' ? 'Open' : 'Show');
	open.title = node.kind === 'file' ? 'Open in editor' : 'Show in Explorer';
	open.dataset.path = node.path;
	open.dataset.kind = node.kind;
	open.addEventListener('click', handleOpenClick);
	actions.appendChild(open);

	// only directories have an arrangement inside them to reset
	if (node.kind !== 'file') {
		const reset = makeTextButton(makeResetIcon(), 'Reset layout');
		reset.title = 'Reset everything inside this node';
		reset.addEventListener('click', handleResetClick);
		actions.appendChild(reset);
	}

	sidebar.appendChild(actions);

	const pathRow = addDetail(sidebar, 'Path', node.path);
	pathRow.querySelector('.sidebar-value')!.replaceChildren(pathWithBreaks(node.path));

	// the same small arrow as the import lists, as a second way to open it right where you're reading
	pathRow.appendChild(makeOpenButton(node.path, node.kind));
	addDetail(sidebar, 'Kind', node.kind);
	if (node.kind !== 'file') {
		addDetail(sidebar, 'Children', String(node.childCount));
	}
	addDetail(sidebar, 'Times imported', String(info.indegrees.get(selectedId!)));

	const linked = connections(selectedId!, info.edges, info.nodesById);
	addConnectionList(sidebar, 'Imports', linked.outgoing);
	addConnectionList(sidebar, 'Imported by', linked.incoming);

	sidebar.classList.add('visible');
}

/** Shows the concrete graph edges represented by the selected visible arrow. */
function drawEdgeSidebar(sidebar: HTMLElement, selected: Edge): void {
	sidebar.replaceChildren();
	const header = document.createElement('div');
	header.className = 'sidebar-header';
	const title = document.createElement('span');
	title.textContent = 'Relationship';
	header.appendChild(title);
	const close = document.createElement('button');
	close.className = 'icon-button sidebar-close';
	close.title = 'Close';
	close.appendChild(makeCloseIcon());
	close.addEventListener('click', handleSidebarClose);
	header.appendChild(close);
	sidebar.appendChild(header);

	const rects = placeBoxes(state, info!, { x: START_X, y: START_Y });
	const strips = placeStrips(state, info!, rects);
	// grouped the same way the arrows are drawn, so a merged arrow lists every import it stands for
	const represented = info!.edges.filter((edge) => {
		const ends = arrowEndsOf(edge, state, info!, rects, strips, arrowDepth);
		return ends !== undefined && ends.from === selected.from && ends.to === selected.to;
	});
	for (const edge of represented) {
		const from = info!.nodesById.get(edge.from)!;
		const to = info!.nodesById.get(edge.to)!;
		addDetail(sidebar, 'Relationship', from.name + ' ' + edge.kind + 's ' + to.name);
		addDetail(sidebar, 'From', from.path);
		addDetail(sidebar, 'To', to.path);
	}
	if (represented.length === 0) {
		addDetail(sidebar, 'Relationship', nodeOfEnd(selected.from) + ' connects to ' + nodeOfEnd(selected.to));
	}
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
 * Makes a gray button with an icon and a label, like VS Code's secondary buttons.
 * @param icon The icon, from icons.ts.
 * @param label The words on the button.
 * @returns The button, with no click handler yet.
 */
function makeTextButton(icon: SVGSVGElement, label: string): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = 'text-button';
	button.appendChild(icon);
	button.append(label);
	return button;
}

/**
 * Clears the selection if something above the selected node has just closed, so the sidebar doesn't keep describing
 * a node you can no longer see. A node merely behind "+N more" stays selected, since its directories are open.
 */
function clearSelectionIfClosedAway(): void {
	if (info === undefined || selectedId === undefined) {
		return;
	}

	// the lineage starts with the node itself, which may be closed; only the nodes above it matter
	const ancestors = getLineage(selectedId, info.nodesById).slice(1);
	for (const ancestorId of ancestors) {
		if (!state.expanded.has(ancestorId)) {
			selectedId = undefined;
			return;
		}
	}
}

/**
 * Resets the selected node and everything inside it to the default layout.
 */
function handleResetClick(): void {
	if (info === undefined || selectedId === undefined) {
		return;
	}
	resetNode(state, info, selectedId);
	drawGraph();
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
 * Makes a button that opens a file in the editor, or shows a directory in the Explorer.
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

	// directory by directory: each directory as a heading you can jump to, then its files by name
	for (const [parentId, childIds] of groupByParent(ids, info!.nodesById)) {
		// files at the top of the repo have no directory, so they get no heading and no indent
		const isTopLevel = parentId === ROOT_ID;
		if (!isTopLevel) {
			sidebar.appendChild(makeLinkRow(parentId, parentId + '/', 'sidebar-directory'));
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
 * @param extraClass A class for how the row looks, like a directory heading or an indented file.
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

	glideTo({ x: middleX - boxCenterX * camera.scale, y: middleY - boxCenterY * camera.scale, scale: camera.scale });
}

// space left around everything when fitting it in view, in screen pixels
const FIT_MARGIN = 40;

/**
 * Moves and zooms the view so every visible box fits in the part of the panel you can see.
 */
function fitToView(): void {
	const bounds = boundsOf(lastRects.values());
	if (bounds === undefined) {
		return;
	}

	// leave out the space under the sidebar card when it's showing
	const sidebarShowing = document.getElementById('sidebar')!.classList.contains('visible');
	const width = sidebarShowing ? window.innerWidth - SIDEBAR_SPACE : window.innerWidth;
	const viewport = { x: 0, y: 0, width: width, height: window.innerHeight };

	glideTo(fitCamera(bounds, viewport, FIT_MARGIN));
}

/**
 * Animates the view to a new camera, then switches the animation off so panning by hand stays instant.
 * @param target Where the camera should end up.
 */
function glideTo(target: Camera): void {
	camera = target;
	document.getElementById('world')!.classList.add('gliding');
	applyCamera();
	setTimeout(stopGliding, GLIDE_TIME);
}

/**
 * Turns off the glide animation after glideTo.
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
 * Clears the selection, which hides the sidebar.
 */
function handleSidebarClose(): void {
	selectedId = undefined;
	selectedEdge = undefined;
	drawGraph();
}

/**
 * Checks whether an event happened on a floating panel, which handles its own
 * clicks and scrolling.
 * @param event Any browser event.
 * @returns True if its target is in either.
 */
function isOnOverlay(event: Event): boolean {
	// the path is recorded when the event starts, so it still holds the sidebar
	// even if a redraw has since removed the element that was clicked
	const path = event.composedPath();
	return path.includes(document.getElementById('sidebar')!)
		|| path.includes(document.getElementById('toolbar')!)
		|| path.includes(document.getElementById('flow-results')!)
		|| path.includes(document.getElementById('flow-description')!);
}

// how strongly arrows draw, from the arrow settings; saved with the layout
let arrowMode: ArrowMode = 'default';

// how many levels below the folder an arrow lives in its ends may go, from the arrow settings; saved with the layout
let arrowDepth = 1;

// the arrow settings' strengths, in order, with their button names and what each does, shown on hover
const ARROW_MODES: { mode: ArrowMode; name: string; title: string }[] = [
	{ mode: 'hidden', name: 'Hidden', title: 'Only the selected box\'s arrows' },
	{ mode: 'default', name: 'Default', title: 'Faint, except the selected box\'s arrows' },
	{ mode: 'full', name: 'Full', title: 'Every arrow in full' },
];

/**
 * Makes a thin line between groups of toolbar controls.
 * @returns The element.
 */
function makeDivider(): HTMLElement {
	const divider = document.createElement('span');
	divider.className = 'toolbar-divider';
	return divider;
}

/**
 * Shows the current arrow strength in the arrow settings: its button pressed, the others not.
 */
function showArrowMode(): void {
	for (const button of document.querySelectorAll<HTMLElement>('.arrow-mode')) {
		button.setAttribute('aria-pressed', String(button.dataset.mode === arrowMode));
	}
}

/**
 * Switches to the clicked arrow strength, then redraws, which also saves it.
 * @param event The browser's mouse event, on one of the strength buttons.
 */
function handleArrowModeClick(event: MouseEvent): void {
	const button = event.currentTarget as HTMLElement;
	arrowMode = button.dataset.mode as ArrowMode;
	showArrowMode();
	drawGraph();
}

/**
 * Finds the graph's deepest level, where top-level boxes are 1. At that depth arrows group nothing.
 * @returns The deepest node's depth, or 1 before a graph arrives.
 */
function deepestLevel(): number {
	// a lineage runs from the node up to the root, so it's one longer than the depth
	let deepest = 1;
	if (info !== undefined) {
		for (const id of info.nodesById.keys()) {
			deepest = Math.max(deepest, getLineage(id, info.nodesById).length - 1);
		}
	}
	return deepest;
}

/**
 * Sets up the toolbar's depth field for the current graph: its max, the dimmed "/ max" beside it, and the current
 * setting, pulled down to the max if the repo has got shallower.
 */
function showArrowDepth(): void {
	const deepest = deepestLevel();
	arrowDepth = Math.min(arrowDepth, deepest);

	const input = document.getElementById('arrow-depth') as HTMLInputElement;
	input.max = String(deepest);
	input.value = String(arrowDepth);
	document.getElementById('arrow-depth-max')!.textContent = '/ ' + deepest;
}

/**
 * Takes the depth typed or stepped to in the toolbar's field, once it's committed: rounded, at least 1 (also for
 * anything that isn't a number), and at most the deepest level. Shows the corrected value, then redraws, which also
 * saves it.
 * @param event The browser's change event, on the field.
 */
function handleArrowDepthChange(event: Event): void {
	const input = event.currentTarget as HTMLInputElement;
	let depth = Math.round(Number(input.value));
	if (Number.isNaN(depth) || depth < 1) {
		depth = 1;
	}
	depth = Math.min(depth, deepestLevel());

	arrowDepth = depth;
	input.value = String(depth);
	drawGraph();
}

/**
 * Opens one of the toolbar's popups, or closes it if it's open. Only one is open at a time.
 * @param id The popup's id.
 */
function togglePopup(id: string): void {
	const popup = document.getElementById(id)!;
	const wasOpen = popup.classList.contains('visible');
	closePopups();
	if (!wasOpen) {
		popup.classList.add('visible');
	}
}

/**
 * Closes every toolbar popup.
 */
function closePopups(): void {
	for (const popup of document.querySelectorAll('.popup')) {
		popup.classList.remove('visible');
	}
}

/**
 * Opens the arrow settings, or closes them if they're open.
 */
function toggleArrowsPopup(): void {
	togglePopup('arrows-popup');
}

/**
 * Opens the settings popup, or closes it if it's open.
 */
function toggleSettings(): void {
	togglePopup('settings');
}

/**
 * Closes the toolbar's popups on a press anywhere outside the toolbar, which holds them.
 * @param event The browser's pointer event.
 */
function closePopupsOutside(event: PointerEvent): void {
	if (!event.composedPath().includes(document.getElementById('toolbar')!)) {
		closePopups();
	}
}

/**
 * Closes the toolbar's popups on Escape.
 * @param event The browser's keyboard event.
 */
function closePopupsOnEscape(event: KeyboardEvent): void {
	if (event.key === 'Escape') {
		closePopups();
	}
}

/**
 * Makes a heading at the top of a toolbar popup.
 * @param text The heading.
 * @returns The element.
 */
function makePopupHeading(text: string): HTMLElement {
	const heading = document.createElement('div');
	heading.className = 'popup-heading';
	heading.textContent = text;
	return heading;
}

/**
 * Makes one row of a toolbar popup: a label, then a place for its control.
 * @param label The label.
 * @param title What the setting does, shown on hovering the label; empty for none.
 * @returns The row, and the element to put the control in.
 */
function makePopupRow(label: string, title: string): { row: HTMLElement; control: HTMLElement } {
	const row = document.createElement('div');
	row.className = 'popup-row';
	const name = document.createElement('span');
	name.textContent = label;
	name.title = title;
	row.appendChild(name);
	const control = document.createElement('div');
	control.className = 'popup-control';
	row.appendChild(control);
	return { row: row, control: control };
}

/**
 * Fills in the toolbar in the top-left corner, all icons: reset and fit, then the arrow settings, then a settings
 * button at the end whose popup holds setup that's rarely changed, like the language model. Runs once, since its
 * buttons never change.
 */
function drawToolbar(): void {
	const toolbar = document.getElementById('toolbar')!;

	const reset = document.createElement('button');
	reset.className = 'icon-button';
	reset.title = 'Reset layout';
	reset.appendChild(makeResetIcon());
	reset.addEventListener('click', handleToolbarReset);
	toolbar.appendChild(reset);

	const fit = document.createElement('button');
	fit.className = 'icon-button';
	fit.title = 'Fit to view';
	fit.appendChild(makeFitIcon());
	fit.addEventListener('click', fitToView);
	toolbar.appendChild(fit);

	// the arrow settings, behind one button: how strongly they draw, and how deep they go
	toolbar.appendChild(makeDivider());
	const arrowsAnchor = document.createElement('span');
	arrowsAnchor.className = 'popup-anchor';
	toolbar.appendChild(arrowsAnchor);
	const arrowsButton = document.createElement('button');
	arrowsButton.className = 'icon-button';
	arrowsButton.title = 'Arrows';
	arrowsButton.appendChild(makeArrowsIcon());
	arrowsButton.addEventListener('click', toggleArrowsPopup);
	arrowsAnchor.appendChild(arrowsButton);

	const arrows = document.createElement('div');
	arrows.id = 'arrows-popup';
	arrows.className = 'popup';
	arrowsAnchor.appendChild(arrows);
	arrows.appendChild(makePopupHeading('Arrows'));

	// how strongly arrows draw: one button per strength, the current one pressed
	const show = makePopupRow('Show', '');
	arrows.appendChild(show.row);
	for (const option of ARROW_MODES) {
		const button = document.createElement('button');
		button.className = 'text-button arrow-mode';
		button.dataset.mode = option.mode;
		button.textContent = option.name;
		button.title = option.title;
		button.addEventListener('click', handleArrowModeClick);
		show.control.appendChild(button);
	}
	showArrowMode();

	// how deep arrows go below the folder each lives in; typed or stepped, from 1 up to the deepest level, which is set
	// once a graph arrives
	const depthTitle = 'Levels below each arrow\'s folder before it groups';
	const depth = makePopupRow('Depth', depthTitle);
	arrows.appendChild(depth.row);
	const depthInput = document.createElement('input');
	depthInput.id = 'arrow-depth';
	depthInput.type = 'number';
	depthInput.min = '1';
	depthInput.step = '1';
	depthInput.setAttribute('aria-label', 'Arrow depth');
	depthInput.title = depthTitle;
	depthInput.addEventListener('change', handleArrowDepthChange);
	depth.control.appendChild(depthInput);

	// the deepest level, dimmed beside the field
	const depthMax = document.createElement('span');
	depthMax.id = 'arrow-depth-max';
	depth.control.appendChild(depthMax);
	showArrowDepth();

	// the settings button, last, with its popup hanging below it
	toolbar.appendChild(makeDivider());
	const settingsAnchor = document.createElement('span');
	settingsAnchor.className = 'popup-anchor';
	toolbar.appendChild(settingsAnchor);
	const settingsButton = document.createElement('button');
	settingsButton.className = 'icon-button';
	settingsButton.title = 'Settings';
	settingsButton.appendChild(makeSettingsIcon());
	settingsButton.addEventListener('click', toggleSettings);
	settingsAnchor.appendChild(settingsButton);

	const settings = document.createElement('div');
	settings.id = 'settings';
	settings.className = 'popup';
	settingsAnchor.appendChild(settings);
	document.addEventListener('pointerdown', closePopupsOutside);
	document.addEventListener('keydown', closePopupsOnEscape);

	settings.appendChild(makePopupHeading('Language model'));
	const modelRow = document.createElement('div');
	modelRow.className = 'settings-row';
	settings.appendChild(modelRow);
	const flowRow = document.createElement('div');
	flowRow.className = 'settings-row';
	settings.appendChild(flowRow);

	const modelSelect = document.createElement('select');
	modelSelect.id = 'model-select';
	modelSelect.title = 'Language model for future AI flow generation';
	modelSelect.setAttribute('aria-label', 'Language model');
	modelSelect.disabled = true;
	const placeholder = document.createElement('option');
	placeholder.value = '';
	placeholder.textContent = 'Choose model';
	modelSelect.appendChild(placeholder);
	modelSelect.addEventListener('change', () => {
		const model = availableModels.find((item) => modelKey(item) === modelSelect.value);
		modelIsAvailable = model !== undefined;
		(document.getElementById('generate-flows') as HTMLButtonElement).disabled = !modelIsAvailable;
		vscode.postMessage({ type: 'selectModel', model: model });
	});
	modelRow.appendChild(modelSelect);

	const findModels = document.createElement('button');
	findModels.className = 'text-button';
	findModels.id = 'find-models';
	findModels.textContent = 'Find models';
	findModels.title = 'Load language models available to VS Code';
	findModels.addEventListener('click', () => {
		findModels.disabled = true;
		findModels.textContent = 'Loading…';
		modelStatus.textContent = '';
		vscode.postMessage({ type: 'discoverModels' });
	});
	modelRow.appendChild(findModels);

	modelStatus = document.createElement('span');
	modelStatus.id = 'model-status';
	modelStatus.setAttribute('role', 'status');
	settings.insertBefore(modelStatus, flowRow);

	const generate = document.createElement('button');
	generate.className = 'text-button';
	generate.id = 'generate-flows';
	generate.textContent = 'Generate flows';
	generate.title = 'Ask the selected language model to find example repository flows';
	generate.disabled = true;
	generate.addEventListener('click', () => {
		const selected = availableModels.find((item) => modelKey(item) === modelSelect.value);
		generate.disabled = true;
		generate.textContent = 'Generating…';
		showFlowResults([], 'Analyzing repository with the selected model…', true);
		vscode.postMessage({ type: 'generateFlows', model: selected });
	});
	flowRow.appendChild(generate);
}

let availableModels: ModelOption[] = [];
let modelIsAvailable = false;

function modelKey(model: ModelOption): string {
	return model.vendor + '\u0000' + model.id;
}

function showModels(models: ModelOption[], selected: ModelOption | undefined, status?: string): void {
	availableModels = models;
	const select = document.getElementById('model-select') as HTMLSelectElement;
	const find = document.getElementById('find-models') as HTMLButtonElement;
	modelStatus.textContent = status ?? (selected ? 'Selected: ' + selected.name : '');
	find.disabled = false;
	find.textContent = 'Find models';
	select.replaceChildren();
	const placeholder = document.createElement('option');
	placeholder.value = '';
	placeholder.textContent = 'Choose model';
	select.appendChild(placeholder);
	for (const model of models) {
		const option = document.createElement('option');
		option.value = modelKey(model);
		option.textContent = model.name + ' (' + model.vendor + ')';
		select.appendChild(option);
	}
	if (selected && !models.some((model) => modelKey(model) === modelKey(selected))) {
		const unavailable = document.createElement('option');
		unavailable.value = modelKey(selected);
		unavailable.textContent = selected.name + ' (currently unavailable)';
		select.appendChild(unavailable);
	}
	select.value = selected ? modelKey(selected) : '';
	select.disabled = models.length === 0;
	modelIsAvailable = selected !== undefined && models.some((model) => modelKey(model) === modelKey(selected));
	(document.getElementById('generate-flows') as HTMLButtonElement).disabled = !modelIsAvailable;
}

let modelStatus: HTMLElement;

function showFlowResults(flows: FlowScenario[], status?: string, loading = false): void {
	const panel = document.getElementById('flow-results')!;
	panel.replaceChildren();
	const header = document.createElement('div');
	header.className = 'flow-results-header';
	const title = document.createElement('strong');
	title.textContent = 'Example flows';
	header.appendChild(title);
	const close = document.createElement('button');
	close.className = 'icon-button';
	close.textContent = '×';
	close.title = 'Close flow results';
	close.setAttribute('aria-label', close.title);
	close.addEventListener('click', () => panel.classList.remove('visible'));
	header.appendChild(close);
	panel.appendChild(header);
	if (status) {
		const message = document.createElement('div');
		message.className = 'flow-status';
		message.textContent = status;
		panel.appendChild(message);
	}
	for (const flow of flows) {
		const card = document.createElement('section');
		card.className = 'flow-card';
		const titleButton = document.createElement('button');
		titleButton.className = 'flow-title-button';
		titleButton.textContent = flow.title;
		titleButton.title = 'Open this flow in a new tab';
		titleButton.addEventListener('click', () => vscode.postMessage({ type: 'openFlow', flow: flow }));
		card.appendChild(titleButton);
		const summary = document.createElement('p');
		summary.textContent = flow.summary;
		card.appendChild(summary);
		const steps = document.createElement('ol');
		for (const step of flow.steps) {
			const row = document.createElement('li');
			const action = document.createElement('span');
			action.textContent = step.action + ' ';
			row.appendChild(action);
			const open = document.createElement('button');
			open.className = 'flow-path-button';
			open.textContent = step.nodeId;
			open.title = 'Open ' + step.nodeId;
			open.addEventListener('click', () => vscode.postMessage({ type: 'open', path: step.nodeId, kind: 'file' }));
			row.appendChild(open);
			steps.appendChild(row);
		}
		card.appendChild(steps);
		panel.appendChild(card);
	}
	panel.classList.add('visible');
	const generate = document.getElementById('generate-flows') as HTMLButtonElement;
	if (!loading) {
		generate.disabled = !modelIsAvailable;
		generate.textContent = 'Generate flows';
	}
}

/**
 * Asks the extension to reset the whole layout; it confirms first, since only it can show VS Code's dialogs.
 */
function handleToolbarReset(): void {
	vscode.postMessage({ type: 'requestReset' });
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
	scheduleSave();
}

// how long to wait after the last change before saving, so a pan saves once instead of on every move
const SAVE_DELAY = 500;

// the pending save, so a newer change can push it back
let saveTimer: ReturnType<typeof setTimeout> | undefined = undefined;

/**
 * Saves the layout once changes have paused for SAVE_DELAY.
 */
function scheduleSave(): void {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(saveLayout, SAVE_DELAY);
}

/**
 * Sends the layout and camera to the extension, which stores them for this workspace.
 */
function saveLayout(): void {
	if (info === undefined) {
		return;
	}
	vscode.postMessage({ type: 'saveLayout', layout: toSaved(state, camera, arrowMode, arrowDepth) });
}

/**
 * Zooms around the mouse. Scrolling is always zoom, never page scroll.
 * @param event The browser's wheel event.
 */
function handleWheel(event: WheelEvent): void {
	// let the sidebar scroll its own lists
	if (isOnOverlay(event)) {
		return;
	}
	event.preventDefault();

	// scrolling up (negative deltaY) zooms in; exp keeps big and tiny steps both smooth
	const factor = Math.exp(-event.deltaY * ZOOM_SPEED);
	camera = zoomAt(camera, { x: event.clientX, y: event.clientY }, factor);
	applyCamera();
}

// where the mouse was at the last move of a press that may pan, or undefined when no such press is happening
let panLast: Position | undefined = undefined;

// whether that press has moved far enough to really be panning, rather than a click
let isPanning = false;

// where the latest press started, so a click that was really a drag can be ignored
let pressStart: Position = { x: 0, y: 0 };

// how far the mouse may move between press and release and still count as a click, in pixels
const CLICK_SLOP = 4;

/**
 * Checks whether a press is on the part of the selected box that moves it: all of it when closed, its title strip
 * when open. Only the selected box can be moved, so everything else is free for panning.
 * @param target The element pressed.
 * @returns True if pressing there should move the box rather than the view.
 */
function isOnGrabArea(target: Element): boolean {
	const box = target.closest<HTMLElement>('.box');
	if (box === null || box.dataset.id !== selectedId) {
		return false;
	}
	return !box.classList.contains('open') || target.closest('.box-title') !== null;
}

/**
 * Notes a press that may become a pan: anywhere but the floating panels, a box's arrow, or the selected box's grab
 * area. Panning only starts once the mouse moves, so a press without movement stays a click.
 * @param event The browser's pointer event.
 */
function handlePointerDown(event: PointerEvent): void {
	pressStart = { x: event.clientX, y: event.clientY };

	const target = event.target as Element;
	if (isOnOverlay(event) || target.closest('.chevron') !== null) {
		return;
	}

	// the corner handle resizes; checked first, since it sits on the box's grab area
	if (target.closest('.resize-handle') !== null && selectedId !== undefined && info !== undefined) {
		resize = { id: selectedId, startSize: boxSize(state, info, selectedId), startMouse: pressStart };
		return;
	}

	// the selected box's grab area moves the box; anywhere else may become a pan
	if (isOnGrabArea(target) && selectedId !== undefined) {
		// where it's drawn among its siblings, which isn't its home when a sibling has grown or the directory is
		// squished; the drop works from this, so the box lands where it was let go
		const parentId = info!.nodesById.get(selectedId)!.parent!;
		const drawn = arrangeShown(state, info!, parentId).rects.get(selectedId)!;
		drag = { id: selectedId, startDrawn: { x: drawn.x, y: drawn.y }, startMouse: pressStart, startState: copyLayoutState(state) };
		return;
	}

	panLast = { x: event.clientX, y: event.clientY };
}

/**
 * Moves the world along with the mouse, once a press has moved past CLICK_SLOP.
 * @param event The browser's pointer event.
 */
function handlePointerMove(event: PointerEvent): void {
	if (resize !== undefined) {
		resizeBox(event);
		return;
	}

	if (drag !== undefined) {
		moveDraggedBox(event);
		return;
	}

	if (panLast === undefined) {
		return;
	}

	if (!isPanning) {
		const moved = Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y);
		if (moved <= CLICK_SLOP) {
			return;
		}

		// now it's a pan: keep receiving moves even if the mouse leaves the panel mid-drag. Starting this only now
		// matters, since capturing sends the coming click to the body instead of the box under the mouse
		isPanning = true;
		document.body.setPointerCapture(event.pointerId);
		document.body.classList.add('panning');
	}

	camera = { x: camera.x + event.clientX - panLast.x, y: camera.y + event.clientY - panLast.y, scale: camera.scale };
	panLast = { x: event.clientX, y: event.clientY };
	applyCamera();
}

/**
 * Ends the press, and the pan if there was one.
 */
function handlePointerUp(): void {
	panLast = undefined;
	isPanning = false;
	document.body.classList.remove('panning');

	// the size was stored as it changed, so this only ends the resize; the last redraw already saved it
	if (resize !== undefined) {
		endResize();
	}

	if (drag !== undefined) {
		const dropped = drag;
		const wasDragging = isDragging;
		drag = undefined;
		isDragging = false;
		document.body.classList.remove('dragging');

		// the drop, from where things were before the drag, so it's the same as dropping there in one go: what it
		// landed on is pushed out of the way, and a redraw in the normal paint order also saves
		if (wasDragging && info !== undefined) {
			const target = { x: dropped.startDrawn.x + dragOffset.x, y: dropped.startDrawn.y + dragOffset.y };
			state = copyLayoutState(dropped.startState);
			dropAt(state, info, dropped.id, target);
			drawGraph();
		}
		dragOffset = { x: 0, y: 0 };
	}
}

// the box being resized, its size and the mouse when the press started; undefined when no handle is pressed
let resize: { id: string; startSize: Size; startMouse: Position } | undefined = undefined;

// whether that press has moved far enough to really be resizing, rather than a click
let isResizing = false;

/**
 * Resizes the pressed box with the mouse, once the press has moved past CLICK_SLOP. Unlike moving, this changes the
 * state as it goes, so neighbors follow live by exactly the size change.
 * @param event The browser's pointer event.
 */
function resizeBox(event: PointerEvent): void {
	if (info === undefined || resize === undefined) {
		return;
	}

	const dx = event.clientX - resize.startMouse.x;
	const dy = event.clientY - resize.startMouse.y;

	if (!isResizing) {
		if (Math.hypot(dx, dy) <= CLICK_SLOP) {
			return;
		}
		isResizing = true;
		document.body.setPointerCapture(event.pointerId);
		document.body.classList.add('resizing');
	}

	// screen pixels to world pixels, measured from the start so small steps can't add up to drift
	resizeTo(state, info, resize.id, { width: resize.startSize.width + dx / camera.scale, height: resize.startSize.height + dy / camera.scale });
	drawGraph();
}

/**
 * Ends a resize.
 */
function endResize(): void {
	resize = undefined;
	isResizing = false;
	document.body.classList.remove('resizing');
}

// the box being moved, where it was drawn among its siblings, where the mouse was when the press started, and the
// state from then, which every step of the drag starts over from; undefined when no box is pressed
let drag: { id: string; startDrawn: Position; startMouse: Position; startState: LayoutState } | undefined = undefined;

// how far the dragged box has been moved so far, in world pixels
let dragOffset: Position = { x: 0, y: 0 };

// whether that press has moved far enough to really be dragging, rather than a click
let isDragging = false;

/**
 * Moves the pressed box with the mouse, once the press has moved past CLICK_SLOP.
 * @param event The browser's pointer event.
 */
function moveDraggedBox(event: PointerEvent): void {
	if (info === undefined || drag === undefined) {
		return;
	}

	const dx = event.clientX - drag.startMouse.x;
	const dy = event.clientY - drag.startMouse.y;

	if (!isDragging) {
		if (Math.hypot(dx, dy) <= CLICK_SLOP) {
			return;
		}

		// now it's a drag: keep receiving moves even if the mouse leaves the panel
		isDragging = true;
		document.body.setPointerCapture(event.pointerId);
		document.body.classList.add('dragging');
	}

	// screen pixels to world pixels, so the box stays under the mouse at any zoom; measured from the start of the
	// drag, so small steps can't add up to drift
	let offsetX = dx / camera.scale;
	let offsetY = dy / camera.scale;

	// inside a directory, it can't go past the left or top edge, the same limit moveTo keeps on drop
	if (info.nodesById.get(drag.id)!.parent !== ROOT_ID) {
		offsetX = Math.max(offsetX, -drag.startDrawn.x);
		offsetY = Math.max(offsetY, -drag.startDrawn.y);
	}

	// the home moves and the directory grows to hold it, starting over from before the drag each time, so a long
	// drag can't build up drift; nothing is pushed until the drop
	dragOffset = { x: offsetX, y: offsetY };
	const target = { x: drag.startDrawn.x + offsetX, y: drag.startDrawn.y + offsetY };
	state = copyLayoutState(drag.startState);
	dragTo(state, info, drag.id, target);
	drawGraph();
}

/**
 * Handles a click: the arrow on a box opens or closes it, anywhere else on a box selects it,
 * and empty space clears the selection.
 * @param event The browser's mouse event.
 */
function handleClick(event: MouseEvent): void {
	if (isOnOverlay(event)) {
		return;
	}
	if (flowView !== undefined) {
		const flowBox = (event.target as Element).closest<HTMLElement>('.flow-node');
		if (flowBox?.dataset.path) {
			vscode.postMessage({ type: 'open', path: flowBox.dataset.path, kind: 'file' });
		}
		return;
	}
	if (info === undefined) {
		return;
	}

	// moved too far: this was a drag, not a click
	const moved = Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y);
	if (moved > CLICK_SLOP) {
		return;
	}

	const target = event.target as Element;
	const strip = target.closest<HTMLElement>('.strip');
	if (strip !== null && info !== undefined) {
		selectedEdge = undefined;
		const ownerId = strip.dataset.ownerId!;
		const side = strip.dataset.side as 'right' | 'bottom';
		showMoreFromStrip(state, info, ownerId, side);
		drawGraph();
		return;
	}
	const box = target.closest<HTMLElement>('.box');
	const id = box?.dataset.id;

	// empty space, or the "+N more" box, which has no node
	if (id === undefined) {
		selectedId = undefined;
		selectedEdge = undefined;
	} else if (target.closest('.chevron') !== null) {
		if (state.expanded.has(id)) {
			closeNode(state, info, id);
			clearSelectionIfClosedAway();
		} else {
			openNode(state, info, id);
		}
	} else {
		selectedId = id;
		selectedEdge = undefined;
	}

	drawGraph();
}

/**
 * Handles a message from the extension.
 * @param event The browser's message event. Its data is what the extension posted.
 */
function handleMessage(event: MessageEvent<ExtensionToWebview>): void {
	if (event.data.type === 'flowGraph') {
		drawFlowGraph(event.data);
		return;
	}
	if (event.data.type === 'flowResults') {
		showFlowResults(event.data.flows, event.data.status);
		return;
	}
	if (event.data.type === 'models') {
		showModels(event.data.models, event.data.selected, event.data.status);
		return;
	}
	if (event.data.type === 'graph') {
		if (event.data.selectedModel !== undefined) {
			modelStatus.textContent = 'Saved: ' + event.data.selectedModel.name + ' (refresh to check availability)';
		}
		info = buildGraphInfo(event.data.graph);

		// pick up where the last session left off, if anything was saved
		if (event.data.layout !== undefined) {
			const restored = fromSaved(event.data.layout, info);
			state = restored.state;
			camera = restored.camera;
			arrowMode = restored.arrowMode;
			arrowDepth = restored.arrowDepth;
			showArrowMode();
		} else {
			state = createLayoutState();
		}
		showArrowDepth();

		// give homes to anything new since the save; boxes already placed keep theirs
		for (const id of state.expanded) {
			layOutChildren(state, info, id);
		}

		applyCamera();
		drawGraph();
	}

	// the user ran Reset Layout: everything back to the default, including the view
	if (event.data.type === 'resetLayout' && info !== undefined) {
		resetNode(state, info, ROOT_ID);
		clearSelectionIfClosedAway();
		camera = { x: 0, y: 0, scale: 1 };
		applyCamera();
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

drawToolbar();
vscode.postMessage({ type: 'ready' });
