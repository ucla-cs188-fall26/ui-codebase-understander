import { Edge, Graph, ROOT_ID } from '../graph/types';
import { ExtensionToWebview, WebviewToExtension } from '../messages';
import { indexChildren, indexNodes } from '../analysis/lookups';
import { computeIndegrees, sortAllChildren } from '../analysis/metrics';
import { liftEdges } from '../analysis/edges';
import { defaultLayout, GAP } from '../layout/defaultLayout';
import { Arrow, arrowPath, placeArrows } from '../layout/arrows';
import { nodeSize } from '../layout/size';
import { Rect, Size } from '../layout/geometry';
import { getVisibleNodes } from '../layout/visibility';

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
 * Makes the layer that holds every arrow.
 * @param arrows The arrows, from placeArrows, already in page coordinates.
 * @returns An svg element. Put it before the boxes so the boxes paint on top.
 */
function drawArrows(arrows: Arrow[]): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.id = 'arrows';

	// one arrowhead shape, defined once and reused by every arrow
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

	for (const arrow of arrows) {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', arrowPath(arrow));
		path.setAttribute('marker-end', 'url(#arrowhead)');
		svg.appendChild(path);
	}

	return svg;
}

/**
 * Draws the root's visible children in a row, replacing whatever was drawn before.
 * @param graph The graph from the extension.
 */
function drawGraph(graph: Graph): void {
	const nodesById = indexNodes(graph.nodes);
	const indegrees = computeIndegrees(nodesById, graph.edges);
	const childrenById = sortAllChildren(indexChildren(graph.nodes), nodesById, indegrees);

	// nothing expanded yet, so this is the root and its first few children
	const visible = getVisibleNodes(childrenById, new Set(), new Map());

	// the root's shown children, most important first; the page itself stands for the root
	const childIds: string[] = [];
	for (const id of visible.nodeIds) {
		if (id !== ROOT_ID) {
			childIds.push(id);
		}
	}

	// only edges between shown children, so a hidden child can't push a shown one rightward
	const shown = new Set(childIds);
	const edges: Edge[] = [];
	for (const edge of liftEdges(ROOT_ID, graph.edges, nodesById)) {
		if (shown.has(edge.from) && shown.has(edge.to)) {
			edges.push(edge);
		}
	}

	const sizes = new Map<string, Size>();
	for (const id of childIds) {
		const node = nodesById.get(id)!;
		sizes.set(id, nodeSize(node.childCount, indegrees.get(id)!));
	}

	const positions = defaultLayout(childIds, edges, sizes);

	// each box's place on the page: its layout position plus the margin, and its size
	const rects = new Map<string, Rect>();
	for (const id of childIds) {
		const position = positions.get(id)!;
		const size = sizes.get(id)!;
		rects.set(id, { x: START_X + position.x, y: START_Y + position.y, width: size.width, height: size.height });
	}

	const world = document.getElementById('world')!;
	world.replaceChildren();

	// arrows first, so the boxes added after them paint on top
	world.appendChild(drawArrows(placeArrows(edges, rects)));

	for (const id of childIds) {
		const node = nodesById.get(id)!;
		const rect = rects.get(id)!;
		world.appendChild(makeBox(node.name, node.kind, rect.x, rect.y, rect.width, rect.height));
	}

	// the layout's bottom edge, so "+N more" can sit below everything
	let bottom = 0;
	for (const id of childIds) {
		bottom = Math.max(bottom, positions.get(id)!.y + sizes.get(id)!.height);
	}

	for (const more of visible.moreBoxes) {
		const size = nodeSize(0, 0);
		const label = '+' + more.hiddenIds.length + ' more';
		world.appendChild(makeBox(label, 'more', START_X, START_Y + bottom + GAP, size.width, size.height));
	}
}

/**
 * Handles a message from the extension.
 * @param event The browser's message event. Its data is what the extension posted.
 */
function handleMessage(event: MessageEvent<ExtensionToWebview>): void {
	if (event.data.type === 'graph') {
		drawGraph(event.data.graph);
	}
}

// listen first, then ask, so the reply can't arrive before anyone is listening
window.addEventListener('message', handleMessage);
vscode.postMessage({ type: 'ready' });
