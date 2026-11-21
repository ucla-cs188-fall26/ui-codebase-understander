import { isInside } from '../analysis/edges';
import { getLineage } from '../analysis/lookups';
import { ROOT_ID } from '../graph/types';
import { Arrow, arrowBounds, placeArrows } from '../layout/arrows';
import { fitCamera } from '../layout/camera';
import { boundsOf, Position, Rect, subtractRect } from '../layout/geometry';
import { arrowTouches, arrowZIndex, boxesUnderArrow, boxZIndexes, nodeOfEnd, placeBoxes, placeStrips, Strip, visibleEdges } from '../layout/place';
import { fromSaved } from '../layout/saved';
import { buildGraphInfo, createLayoutState, holdPages, layOutChildren, listPages, resetNode } from '../layout/state';
import { ExtensionToWebview, FlowGraphMessage, FlowScenario, modelKey, ModelOption } from '../messages';
import { FADE_BANDS, FADE_STEP, isSelectedEdge, makeArrow, resetArrowIds } from './arrowElements';
import { makeElement, makeIconButton, placeAt } from './dom';
import { makeFitIcon, makeGripIcon, makeResizeIcon } from './icons';
import { draggedId, handleClick, handlePointerDown, handlePointerMove, handlePointerUp } from './input';
import { makePageCounter } from './pageMenu';
import { clearSelectionIfClosedAway, drawSidebar } from './sidebar';
import { applyStyle } from './style';
import { drawToolbar, makePopupHeading, showArrowDepth, showArrowMode } from './toolbar';
import { setRedraw, view, vscode } from './view';
import { applyCamera, FIT_MARGIN, fitToView, handleWheel, scheduleSave } from './viewport';
// margin between the panel's top-left corner and the layout
const START_X = 40;
const START_Y = 40;

// added to the z-index of a dragged box and everything inside it, so they paint above every other box and arrow
const DRAG_RAISE = 100000;

/**
 * Makes one box element.
 * @param label The text inside the box.
 * @param kind A class for styling: 'repo', 'directory', or 'file'.
 * @param rect Where it goes, in pixels.
 * @returns The element, absolutely positioned. Not on the page until someone appends it.
 */
function makeBox(label: string, kind: string, rect: Rect): HTMLElement {
    const box = makeElement('div', 'box ' + kind);
    placeAt(box, rect);

    // the title: all of a closed box, the strip across the top of an open one; it's where you grab a box to move it
    const title = makeElement('div', 'box-title');
    box.appendChild(title);

    const text = makeElement('span', 'label', label);
    title.appendChild(text);

    return box;
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
    const draggingId = draggedId();
    if (draggingId === undefined || view.info === undefined) {
        return false;
    }

    const dragged = rects.get(draggingId)!;
    function isUnderDraggedBox(point: Position): boolean {
        return point.x > dragged.x && point.x < dragged.x + dragged.width && point.y > dragged.y && point.y < dragged.y + dragged.height;
    }

    // an end that belongs to the dragged box (or something in it, strips included) moves with it, so it's never
    // hidden by it
    const fromDragged = isInside(nodeOfEnd(arrow.from), draggingId, view.info.nodesById);
    const toDragged = isInside(nodeOfEnd(arrow.to), draggingId, view.info.nodesById);

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
    const element = makeElement('div', 'strip strip-' + strip.side, '+' + strip.hiddenIds.length);
    element.dataset.ownerId = strip.ownerId;
    element.dataset.side = strip.side;
    placeAt(element, strip.rect);
    element.style.zIndex = String(zIndex);

    // the hidden names on hover
    const names: string[] = [];
    for (const id of strip.hiddenIds) {
        names.push(view.info!.nodesById.get(id)!.name);
    }
    element.title = names.join('\n');

    return element;
}

/**
 * Draws every visible box and arrow from the current state, replacing whatever was drawn before.
 */
function drawGraph(): void {
    if (view.info === undefined) {
        return;
    }

    const rects = placeBoxes(view.state, view.info, { x: START_X, y: START_Y });
    view.lastRects = rects;

    // the box being dragged, if any
    const draggingId = draggedId();

    const world = document.getElementById('world')!;
    world.replaceChildren();

    // paint order: each box gets a z-index, and each arrow sits just above the open boxes holding its ends
    const boxZ = boxZIndexes(rects);

    // while dragging, the box and everything inside it paint above the rest as one unit
    if (draggingId !== undefined) {
        for (const [id, z] of boxZ) {
            if (isInside(id, draggingId, view.info.nodesById)) {
                boxZ.set(id, z + DRAG_RAISE);
            }
        }
    }

    // strips stand in for hidden children; arrows to those end at the strip, so it goes in with the box rects
    const strips = placeStrips(view.state, view.info, rects);
    const arrowRects = new Map(rects);
    for (const strip of strips) {
        arrowRects.set(strip.id, strip.rect);
        world.appendChild(makeStrip(strip, (boxZ.get(strip.ownerId) ?? 0) + 1));
    }

    // the selected box's arrows aren't merged into the folders around them
    const kept: string[] = [];
    if (view.selectedId !== undefined) {
        kept.push(view.selectedId);
    }
    // the selected arrow stays as it was clicked, without splitting out any other arrow
    const edges = visibleEdges(view.state, view.info, rects, strips, view.arrowDepth, kept, view.selectedEdge);
    view.lastEdges = edges;
    const arrows = placeArrows(edges, arrowRects);

    resetArrowIds();

    // the box being dragged, which paints on top of everything around it
    let dragged: Rect | undefined = undefined;
    if (draggingId !== undefined) {
        dragged = rects.get(draggingId);
    }
    for (let i = 0; i < arrows.length; i++) {
        // while dragging, the dragged box's own arrow to something under it would be a stub pointing back into it
        if (endsUnderDraggedBox(arrows[i], rects)) {
            continue;
        }

        // placeArrows keeps the edges' order, so arrows[i] belongs to edges[i]

        // the selected box's arrows, and a selected arrow, always draw in full; the rest go by the toolbar setting
        const lit = isSelectedEdge(edges[i]) || (view.selectedId !== undefined && arrowTouches(edges[i], view.selectedId, view.info));
        if (!lit && view.arrowMode === 'hidden') {
            continue;
        }
        const faint = !lit && view.arrowMode === 'default';

        // an arrow drawn on the dragged box isn't cut where the dragged box covers other boxes, since it paints on
        // top of them
        const onDragged = dragged !== undefined
            && (isInside(nodeOfEnd(edges[i].from), draggingId!, view.info.nodesById) || isInside(nodeOfEnd(edges[i].to), draggingId!, view.info.nodesById));
        // only boxes near enough for their cut-out or fade bands to reach the arrow
        const area = arrowBounds(arrows[i]);
        const reach = FADE_BANDS * FADE_STEP;
        const near = { x: area.x - reach, y: area.y - reach, width: area.width + reach * 2, height: area.height + reach * 2 };
        const under: Rect[] = [];
        for (const id of boxesUnderArrow(edges[i], view.info, rects, near)) {
            const rect = rects.get(id)!;
            if (onDragged) {
                for (const piece of subtractRect(rect, dragged!)) {
                    under.push(piece);
                }
            } else {
                under.push(rect);
            }
        }
        const uncovered = onDragged ? dragged : undefined;
        world.appendChild(makeArrow(arrows[i], edges[i], arrowZIndex(edges[i], view.state, view.info, boxZ), under, faint, uncovered));
    }

    for (const [id, rect] of rects) {
        const node = view.info.nodesById.get(id)!;
        const isOpen = view.state.expanded.has(id);
        const kind = isOpen ? node.kind + ' open' : node.kind;
        const box = makeBox(node.name, kind, rect);

        // how deeply it's nested, for its shade: top-level boxes are 1; a lineage runs from the node up to the root
        box.style.setProperty('--depth', String(getLineage(id, view.info.nodesById).length - 1));

        // so a click can tell which node it landed on
        box.dataset.id = id;
        box.style.zIndex = String(boxZ.get(id));

        if (id === view.selectedId) {
            box.classList.add('selected');
        }

        // the title strip, which the chevron, page number and grip go in
        const titleBar = box.querySelector('.box-title')!;

        // anything that can hold children gets an arrow to open or close it, except the root, which is always open
        if (node.kind !== 'file' && id !== ROOT_ID) {
            const chevron = makeElement('span', 'chevron', isOpen ? '▾' : '▸');
            titleBar.prepend(chevron);
        }

        // which page an open directory is on, just after its name; nothing when everything fits on one
        const pages = isOpen ? listPages(view.state, view.info, id) : [];
        if (pages.length > 1) {
            titleBar.appendChild(makePageCounter(id, pages));
        }

        // a grip at the title's right end, so it's clear the title is where to grab the box; the root can't be dragged
        if (id !== ROOT_ID) {
            const grip = makeElement('span', 'grip');
            grip.appendChild(makeGripIcon());
            titleBar.appendChild(grip);
        }

        // only the selected box can be resized, the same as moving; the root always can, since it's hard to select
        if (id === view.selectedId || id === ROOT_ID) {
            const handle = makeElement('span', 'resize-handle');
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

// the flow view's boxes: their size, and the gap between them
const FLOW_BOX = { width: 280, height: 112 };
const FLOW_GAP = 110;

/**
 * Draws a flow, in its own panel, as one row of boxes left to right, with the graph's boxes and arrows. Its toolbar and
 * description replace the graph's.
 * @param flowMessage The flow and its files.
 */
function drawFlowGraph(flowMessage: FlowGraphMessage): void {
    view.flowView = flowMessage;
    view.info = undefined;
    const toolbar = document.getElementById('toolbar')!;
    toolbar.replaceChildren();
    const title = makeElement('strong', 'flow-view-title', flowMessage.flow.title);
    toolbar.appendChild(title);
    const fit = makeIconButton(makeFitIcon(), 'Fit flow to view', fitToView);
    toolbar.appendChild(fit);

    const description = document.getElementById('flow-description')!;
    description.replaceChildren();
    const summary = makeElement('div', '', flowMessage.flow.summary);
    description.appendChild(summary);
    const entry = makeElement('small', '', 'Entry point: ' + flowMessage.flow.entryNodeId);
    description.appendChild(entry);
    description.classList.add('visible');
    document.getElementById('flow-results')!.classList.remove('visible');
    document.getElementById('sidebar')!.classList.remove('visible');

    const world = document.getElementById('world')!;
    world.replaceChildren();

    // what each file does in the flow
    const actions = new Map<string, string>();
    for (const step of flowMessage.flow.steps) {
        actions.set(step.nodeId, step.action);
    }

    // one row, centered down the panel
    const rects = new Map<string, Rect>();
    const y = Math.max(100, window.innerHeight / 2 - FLOW_BOX.height / 2);
    for (let i = 0; i < flowMessage.graph.nodes.length; i++) {
        rects.set(flowMessage.graph.nodes[i].id, { x: START_X + i * (FLOW_BOX.width + FLOW_GAP), y: y, width: FLOW_BOX.width, height: FLOW_BOX.height });
    }

    // the boxes sit in one row, so no arrow passes under any
    const arrows = placeArrows(flowMessage.graph.edges, rects);
    for (let i = 0; i < arrows.length; i++) {
        const flowEdge = flowMessage.graph.edges[i];
        world.appendChild(makeArrow(arrows[i], { from: flowEdge.from, to: flowEdge.to, kind: flowEdge.kind, count: 1, edges: [flowEdge] }, 1, [], false, undefined));
    }

    for (let i = 0; i < flowMessage.graph.nodes.length; i++) {
        const node = flowMessage.graph.nodes[i];
        const box = makeBox(node.name, node.kind, rects.get(node.id)!);
        box.classList.add('flow-node');
        box.dataset.id = node.id;
        box.dataset.path = node.path;
        box.style.zIndex = '2';
        box.appendChild(makeElement('div', 'flow-node-path', node.path));
        box.appendChild(makeElement('div', 'flow-step-action', (i + 1) + '. ' + (actions.get(node.id) ?? '')));
        world.appendChild(box);
    }
    view.lastRects = rects;
    const bounds = boundsOf(rects.values());
    if (bounds !== undefined) {
        view.camera = fitCamera(bounds, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, FIT_MARGIN);
        applyCamera();
    }
}

/**
 * Fills the settings popup with the language model setup: the model list, Find models, and Generate flows.
 * @param settings The settings popup, from drawToolbar.
 */
function fillModelSettings(settings: HTMLElement): void {
    settings.appendChild(makePopupHeading('Language model'));
    const modelRow = makeElement('div', 'settings-row');
    settings.appendChild(modelRow);
    const flowRow = makeElement('div', 'settings-row');
    settings.appendChild(flowRow);

    const modelSelect = document.createElement('select');
    modelSelect.id = 'model-select';
    modelSelect.title = 'Language model for future AI flow generation';
    modelSelect.setAttribute('aria-label', 'Language model');
    modelSelect.disabled = true;
    modelSelect.appendChild(makeModelPlaceholder());
    modelSelect.addEventListener('change', handleModelChange);
    modelRow.appendChild(modelSelect);

    const findModels = makeElement('button', 'text-button', 'Find models');
    findModels.id = 'find-models';
    findModels.title = 'Load language models available to VS Code';
    findModels.addEventListener('click', handleFindModelsClick);
    modelRow.appendChild(findModels);

    modelStatus = makeElement('span');
    modelStatus.id = 'model-status';
    modelStatus.setAttribute('role', 'status');
    settings.insertBefore(modelStatus, flowRow);

    const generate = makeElement('button', 'text-button', 'Generate flows');
    generate.id = 'generate-flows';
    generate.title = 'Ask the selected language model to find example repository flows';
    generate.disabled = true;
    generate.addEventListener('click', handleGenerateClick);
    flowRow.appendChild(generate);
}

// the language models the extension found, whether the one chosen is among them, and where the settings say so
let availableModels: ModelOption[] = [];
let modelIsAvailable = false;
let modelStatus: HTMLElement;

/**
 * Finds a model the extension found, by its key.
 * @param key A key from modelKey, like the model list's values.
 * @returns The model, or undefined if it wasn't found.
 */
function findModel(key: string): ModelOption | undefined {
    return availableModels.find(function hasKey(model: ModelOption): boolean {
        return modelKey(model) === key;
    });
}

/**
 * Turns the Generate flows button on only while the chosen model is available.
 */
function updateGenerateButton(): void {
    (document.getElementById('generate-flows') as HTMLButtonElement).disabled = !modelIsAvailable;
}

/**
 * Makes the model list's first entry, which asks for a choice.
 * @returns The option.
 */
function makeModelPlaceholder(): HTMLOptionElement {
    const placeholder = makeElement('option', '', 'Choose model');
    placeholder.value = '';
    return placeholder;
}

/**
 * Remembers the model picked from the list.
 * @param event The browser's change event, on the list.
 */
function handleModelChange(event: Event): void {
    const model = findModel((event.currentTarget as HTMLSelectElement).value);
    modelIsAvailable = model !== undefined;
    updateGenerateButton();
    vscode.postMessage({ type: 'selectModel', model: model });
}

/**
 * Asks the extension for the language models it can use.
 * @param event The browser's mouse event, on the Find models button.
 */
function handleFindModelsClick(event: MouseEvent): void {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = 'Loading…';
    modelStatus.textContent = '';
    vscode.postMessage({ type: 'discoverModels' });
}

/**
 * Asks the extension to generate flows with the chosen model, showing that it's working.
 * @param event The browser's mouse event, on the Generate flows button.
 */
function handleGenerateClick(event: MouseEvent): void {
    const selected = findModel((document.getElementById('model-select') as HTMLSelectElement).value);
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = 'Generating…';
    showFlowResults([], 'Analyzing repository with the selected model…', true);
    vscode.postMessage({ type: 'generateFlows', model: selected });
}

/**
 * Fills the model list with the models the extension found, keeping the chosen one even if it's no longer available.
 * @param models The models found.
 * @param selected The model chosen before, if any.
 * @param status A message to show under the list; by default, which model is chosen.
 */
function showModels(models: ModelOption[], selected: ModelOption | undefined, status?: string): void {
    availableModels = models;
    const select = document.getElementById('model-select') as HTMLSelectElement;
    const find = document.getElementById('find-models') as HTMLButtonElement;
    modelStatus.textContent = status ?? (selected ? 'Selected: ' + selected.name : '');
    find.disabled = false;
    find.textContent = 'Find models';

    select.replaceChildren(makeModelPlaceholder());
    for (const model of models) {
        const option = makeElement('option', '', model.name + ' (' + model.vendor + ')');
        option.value = modelKey(model);
        select.appendChild(option);
    }
    const isFound = selected !== undefined && findModel(modelKey(selected)) !== undefined;
    if (selected !== undefined && !isFound) {
        const unavailable = makeElement('option', '', selected.name + ' (currently unavailable)');
        unavailable.value = modelKey(selected);
        select.appendChild(unavailable);
    }
    select.value = selected ? modelKey(selected) : '';
    select.disabled = models.length === 0;
    modelIsAvailable = isFound;
    updateGenerateButton();
}

/**
 * Shows the flows the model found, each with its steps; clicking a flow opens it in its own panel, and clicking a step's
 * file opens the file.
 * @param flows The flows.
 * @param status A message to show above them, if any.
 * @param loading True while the model is still working, so Generate flows stays off.
 */
function showFlowResults(flows: FlowScenario[], status?: string, loading = false): void {
    const panel = document.getElementById('flow-results')!;
    panel.replaceChildren();

    const header = makeElement('div', 'flow-results-header');
    header.appendChild(makeElement('strong', '', 'Example flows'));
    const close = makeElement('button', 'icon-button', '×');
    close.title = 'Close flow results';
    close.setAttribute('aria-label', close.title);
    function hide(): void {
        panel.classList.remove('visible');
    }
    close.addEventListener('click', hide);
    header.appendChild(close);
    panel.appendChild(header);

    if (status) {
        panel.appendChild(makeElement('div', 'flow-status', status));
    }
    for (const flow of flows) {
        panel.appendChild(makeFlowCard(flow));
    }
    panel.classList.add('visible');

    if (!loading) {
        updateGenerateButton();
        (document.getElementById('generate-flows') as HTMLButtonElement).textContent = 'Generate flows';
    }
}

/**
 * Makes one flow in the results: its title, which opens it, its summary, and its steps, each with its file.
 * @param flow The flow.
 * @returns The element.
 */
function makeFlowCard(flow: FlowScenario): HTMLElement {
    const card = makeElement('section', 'flow-card');
    const titleButton = makeElement('button', 'flow-title-button', flow.title);
    titleButton.title = 'Open this flow in a new tab';
    function openFlow(): void {
        vscode.postMessage({ type: 'openFlow', flow: flow });
    }
    titleButton.addEventListener('click', openFlow);
    card.appendChild(titleButton);
    card.appendChild(makeElement('p', '', flow.summary));

    const steps = makeElement('ol');
    for (const step of flow.steps) {
        const row = makeElement('li');
        row.appendChild(makeElement('span', '', step.action + ' '));
        const open = makeElement('button', 'flow-path-button', step.nodeId);
        open.title = 'Open ' + step.nodeId;
        function openFile(): void {
            vscode.postMessage({ type: 'open', path: step.nodeId, kind: 'file' });
        }
        open.addEventListener('click', openFile);
        row.appendChild(open);
        steps.appendChild(row);
    }
    card.appendChild(steps);
    return card;
}

/**
 * Handles a message from the extension.
 * @param event The browser's message event. Its data is what the extension posted.
 */
function handleMessage(event: MessageEvent<ExtensionToWebview>): void {
    if (event.data.type === 'style') {
        applyStyle(event.data.colors);
        return;
    }
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
        view.info = buildGraphInfo(event.data.graph);

        // pick up where the last session left off, if anything was saved
        if (event.data.layout !== undefined) {
            const restored = fromSaved(event.data.layout, view.info);
            view.state = restored.state;
            view.camera = restored.camera;
            view.arrowMode = restored.arrowMode;
            view.arrowDepth = restored.arrowDepth;
            showArrowMode();
        } else {
            view.state = createLayoutState();
        }
        showArrowDepth();

        // give homes to anything new since the save; boxes already placed keep theirs
        for (const id of view.state.expanded) {
            layOutChildren(view.state, view.info, id);
        }

        // a page too big for the size its box was given gets room, instead of squishing boxes off it; held room isn't
        // saved, so it's worked out again here
        holdPages(view.state, view.info);

        applyCamera();
        drawGraph();
    }

    // the user ran Reset Layout: everything back to the default, including the view
    if (event.data.type === 'resetLayout' && view.info !== undefined) {
        resetNode(view.state, view.info, ROOT_ID);
        clearSelectionIfClosedAway();
        view.camera = { x: 0, y: 0, scale: 1 };
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

// the other files redraw through this, so they don't have to import this one
setRedraw(drawGraph);

applyStyle();
fillModelSettings(drawToolbar());
vscode.postMessage({ type: 'ready' });
