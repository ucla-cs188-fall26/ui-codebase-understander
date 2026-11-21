import { connections, isInside } from '../analysis/edges';
import { getLineage } from '../analysis/lookups';
import { Edge, LineRange, NodeKind } from '../graph/types';
import { groupInside, groupLinks, LinkGroup, nodeOfEnd } from '../layout/place';
import { resetNode, showNode } from '../layout/state';
import { makeElement, makeTextButton } from './dom';
import { makeCloseIcon, makeOpenIcon, makeResetIcon } from './icons';
import { redraw, view, vscode } from './view';
import { centerOn } from './viewport';

// the sidebar: the selected box's or arrow's details, and the lists of what it connects to

/**
 * Shows the selected node's details in the sidebar, or hides the sidebar when nothing is selected.
 */
export function drawSidebar(): void {
    const sidebar = document.getElementById('sidebar')!;
    if (view.info === undefined || (view.selectedId === undefined && view.selectedEdge === undefined)) {
        sidebar.classList.remove('visible');
        return;
    }
    if (view.selectedEdge !== undefined) {
        drawEdgeSidebar(sidebar, view.selectedEdge);
        return;
    }

    const node = view.info.nodesById.get(view.selectedId!)!;
    sidebar.replaceChildren();

    // rows opened in the lists belong to the box they were opened for
    if (openLinkRowsFor !== view.selectedId) {
        openLinkRows.clear();
        openLinkRowsFor = view.selectedId;
    }

    addSidebarHeader(sidebar, document.createTextNode(node.name));

    // what you can do with this node, before the details you read
    const actions = makeElement('div', 'sidebar-actions');

    // short labels so both buttons fit on one line; the tooltip says it in full
    const open = makeOpenButton(node.path, node.kind, node.kind === 'file' ? 'Open' : 'Show');
    actions.appendChild(open);

    // a directory resets everything inside it; a file only has its size to reset
    const reset = makeTextButton(makeResetIcon(), node.kind === 'file' ? 'Reset size' : 'Reset layout');
    reset.title = node.kind === 'file' ? 'Put this box back to its default size' : 'Reset everything inside this node';
    reset.addEventListener('click', handleResetClick);
    actions.appendChild(reset);

    sidebar.appendChild(actions);

    const pathRow = addDetail(sidebar, 'Path', node.path);
    pathRow.querySelector('.sidebar-value')!.replaceChildren(pathWithBreaks(node.path));

    // the same small arrow as the import lists, as a second way to open it right where you're reading
    pathRow.appendChild(makeOpenButton(node.path, node.kind));
    addDetail(sidebar, 'Kind', node.kind);
    if (node.kind !== 'file') {
        addDetail(sidebar, 'Children', String(node.childCount));
    }
    addDetail(sidebar, 'Times imported', String(view.info.indegrees.get(view.selectedId!)));

    // every place each file row's import is written, in the order they're written, listed under the row when it's
    // opened. Under "Imports", the places inside this box that import the row's file; under "Imported by", the lines
    // in the row's file that import something in this box
    const importsAt = new Map<string, ImportLine[]>();
    const importedByAt = new Map<string, ImportLine[]>();
    for (const edge of view.info.edges) {
        if (edge.lines === undefined) {
            continue;
        }
        const fromInside = isInside(edge.from, view.selectedId!, view.info.nodesById);
        const toInside = isInside(edge.to, view.selectedId!, view.info.nodesById);
        if (toInside && !fromInside) {
            // the file in this box it imports
            addImportLine(importedByAt, edge.from, { path: edge.from, lines: edge.lines, label: pathFrom(view.selectedId!, edge.to) });
        }
        if (fromInside && !toInside) {
            // the file in this box that imports it
            addImportLine(importsAt, edge.to, { path: edge.from, lines: edge.lines, label: pathFrom(view.selectedId!, edge.from) });
        }
    }

    const linked = connections(view.selectedId!, view.info.edges, view.info.nodesById);
    addConnectionList(sidebar, 'Imports', groupLinks(view.selectedId!, linked.outgoing, view.info, view.arrowDepth), {
        hint: 'What this depends on, by importing it',
        lines: importsAt,
    });
    addConnectionList(sidebar, 'Imported by', groupLinks(view.selectedId!, linked.incoming, view.info, view.arrowDepth), {
        hint: 'What depends on this, by importing it',
        lines: importedByAt,
    });

    sidebar.classList.add('visible');
}

/**
 * Shows the selected arrow in the sidebar: its two ends and how many imports it stands for, then the files at each
 * end, grouped by the folders inside each end's box and opening like the box sidebar's lists.
 * @param sidebar The sidebar element.
 * @param selected The arrow's edge.
 */
function drawEdgeSidebar(sidebar: HTMLElement, selected: Edge): void {
    sidebar.replaceChildren();

    // rows opened in the lists stay open while this arrow is selected
    const arrowKey = selected.from + '\n\n' + selected.to;
    if (openLinkRowsFor !== arrowKey) {
        openLinkRows.clear();
        openLinkRowsFor = arrowKey;
    }

    // the arrow as last drawn carries every import it stands for, grouped the same way
    let represented: Edge[] = [];
    for (const arrow of view.lastEdges) {
        if (arrow.from === selected.from && arrow.to === selected.to) {
            represented = arrow.edges;
        }
    }

    // how many imports come from each file on one end, and go to each file on the other
    const fromCounts = new Map<string, number>();
    const toCounts = new Map<string, number>();
    for (const edge of represented) {
        fromCounts.set(edge.from, (fromCounts.get(edge.from) ?? 0) + 1);
        toCounts.set(edge.to, (toCounts.get(edge.to) ?? 0) + 1);
    }

    // every line where each importing file imports something at the other end, listed under its row when it's opened
    const fromLines = new Map<string, ImportLine[]>();
    for (const edge of represented) {
        if (edge.lines !== undefined) {
            // the file at the other end it imports
            addImportLine(fromLines, edge.from, { path: edge.from, lines: edge.lines, label: pathFrom(nodeOfEnd(selected.to), edge.to) });
        }
    }

    // the header: the two ends
    const title = document.createDocumentFragment();
    title.appendChild(makeEndLabel(selected.from, endName(selected.from)));
    title.appendChild(document.createTextNode(' → '));
    title.appendChild(makeEndLabel(selected.to, endName(selected.to)));
    addSidebarHeader(sidebar, title);

    // the same label and value rows as a box's sidebar; the ends' values are filled in after, since a hidden end is
    // styled
    addDetail(sidebar, 'From', '').querySelector('.sidebar-value')!.appendChild(makeEndLabel(selected.from, endPath(selected.from)));
    addDetail(sidebar, 'To', '').querySelector('.sidebar-value')!.appendChild(makeEndLabel(selected.to, endPath(selected.to)));
    addDetail(sidebar, 'Kind', 'import');
    addDetail(sidebar, 'Imports', String(represented.length));

    // section headings are plain, so a hidden end just says so in words
    const fromBox = nodeOfEnd(selected.from);
    const toBox = nodeOfEnd(selected.to);
    addConnectionList(sidebar, 'From', groupInside(fromBox, fromCounts, view.info!), {
        name: hiddenPrefix(selected.from) + endName(selected.from),
        hint: 'Where the arrow starts: the files doing the importing',
        relativeTo: fromBox,
        lines: fromLines,
    });
    addConnectionList(sidebar, 'To', groupInside(toBox, toCounts, view.info!), {
        name: hiddenPrefix(selected.to) + endName(selected.to),
        hint: 'What the arrow points at: the files being imported',
        relativeTo: toBox,
    });
    sidebar.classList.add('visible');
}

/**
 * Adds the sidebar's header: a title, then a button that closes the sidebar.
 * @param sidebar The sidebar element.
 * @param title What goes in the title: the box's name, or the arrow's two ends.
 */
function addSidebarHeader(sidebar: HTMLElement, title: HTMLElement | DocumentFragment | Text): void {
    const header = makeElement('div', 'sidebar-header');
    const titleElement = document.createElement('span');
    titleElement.appendChild(title);
    header.appendChild(titleElement);

    const close = makeElement('button', 'icon-button sidebar-close');
    close.title = 'Close';
    close.appendChild(makeCloseIcon());
    close.addEventListener('click', handleSidebarClose);
    header.appendChild(close);

    sidebar.appendChild(header);
}

/**
 * Names an arrow's end for the sidebar: its box's name, or for a strip, the folder it's hidden in.
 * @param end A box's or strip's id.
 * @returns The name.
 */
function endName(end: string): string {
    return view.info!.nodesById.get(nodeOfEnd(end))!.name;
}

/**
 * Writes where an arrow's end is, for the sidebar: its box's path, or for a strip, the folder it's hidden in.
 * @param end A box's or strip's id.
 * @returns The path.
 */
function endPath(end: string): string {
    return view.info!.nodesById.get(nodeOfEnd(end))!.path;
}

/**
 * Words to put before a hidden end's name, in plain text like section headings.
 * @param end A box's or strip's id.
 * @returns "hidden in " for a strip, nothing for a box.
 */
function hiddenPrefix(end: string): string {
    return end === nodeOfEnd(end) ? '' : 'hidden in ';
}

/**
 * Makes an arrow's end as the sidebar shows it: the name or path, after a dim, italic "hidden in" when the end is a
 * strip, so it's clear the arrow goes to boxes hidden there.
 * @param end A box's or strip's id.
 * @param text Its name or path, from endName or endPath.
 * @returns The element.
 */
function makeEndLabel(end: string, text: string): HTMLElement {
    const label = document.createElement('span');
    if (end !== nodeOfEnd(end)) {
        const hidden = makeElement('em', 'sidebar-hidden', 'hidden in ');
        label.appendChild(hidden);
    }
    label.appendChild(document.createTextNode(text));
    return label;
}

/**
 * Adds one "label: value" row to the sidebar.
 * @param sidebar The sidebar element.
 * @param label What the value is.
 * @param value The value.
 * @returns The row, so more can be added to it.
 */
function addDetail(sidebar: HTMLElement, label: string, value: string): HTMLElement {
    const row = makeElement('div', 'sidebar-row');

    const labelElement = makeElement('span', 'sidebar-label', label);
    row.appendChild(labelElement);

    const valueElement = makeElement('span', 'sidebar-value', value);
    row.appendChild(valueElement);

    sidebar.appendChild(row);
    return row;
}

/**
 * Clears the selection if something above the selected node has just closed, so the sidebar doesn't keep describing
 * a node you can no longer see. A node merely behind "+N more" stays selected, since its directories are open.
 */
export function clearSelectionIfClosedAway(): void {
    if (view.info === undefined || view.selectedId === undefined) {
        return;
    }

    // the lineage starts with the node itself, which may be closed; only the nodes above it matter
    const ancestors = getLineage(view.selectedId, view.info.nodesById).slice(1);
    for (const ancestorId of ancestors) {
        if (!view.state.expanded.has(ancestorId)) {
            view.selectedId = undefined;
            return;
        }
    }
}

/**
 * Resets the selected node and everything inside it to the default layout.
 */
function handleResetClick(): void {
    if (view.info === undefined || view.selectedId === undefined) {
        return;
    }
    resetNode(view.state, view.info, view.selectedId);
    redraw();
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

// one place an import is written: the file, its lines, and how its row reads
interface ImportLine {
    path: string;
    lines: LineRange;
    label: string; // the other file in the import, by its path from the box
}

/**
 * Writes a node's path from a box it's inside, so it's short: "v1/events.js" from app/api. The box itself is just its
 * name.
 * @param boxId The box.
 * @param id The node, inside the box or the box itself.
 * @returns The path from the box.
 */
function pathFrom(boxId: string, id: string): string {
    return pathInside(boxId, id) ?? view.info!.nodesById.get(id)!.name;
}

/**
 * Writes a node's path from a box it's inside: "v1/events.js" from app/api.
 * @param boxId The box.
 * @param id The node.
 * @returns The path from the box, or undefined if the node isn't inside it (or is the box itself).
 */
function pathInside(boxId: string, id: string): string | undefined {
    if (id.startsWith(boxId + '/')) {
        return id.slice(boxId.length + 1);
    }
    return undefined;
}

// the optional parts of a list in the sidebar
interface ListOptions {
    name?: string; // a box's name after the title, kept in its own case
    hint?: string; // what the list means, shown on hovering its title
    relativeTo?: string; // a box whose rows these are inside, so top rows show their path from it
    lines?: Map<string, ImportLine[]>; // the places each file row's import is written, listed under it when opened
}

/**
 * Adds a place an import is written to a row's list of them.
 * @param byRow Each row's places, by the row's id.
 * @param rowId The row.
 * @param line The place.
 */
function addImportLine(byRow: Map<string, ImportLine[]>, rowId: string, line: ImportLine): void {
    const known = byRow.get(rowId);
    if (known !== undefined) {
        known.push(line);
    } else {
        byRow.set(rowId, [line]);
    }
}

/**
 * Makes a button that opens a file in the editor, or shows a directory in the Explorer.
 * @param path The node's repo-relative path.
 * @param kind The node's kind, which decides what opening means.
 * @param label Words for a gray text button, like the sidebar's actions; empty for just the icon.
 * @returns The button.
 */
function makeOpenButton(path: string, kind: NodeKind, label = ''): HTMLButtonElement {
    let button: HTMLButtonElement;
    if (label !== '') {
        button = makeTextButton(makeOpenIcon(), label);
    } else {
        button = makeElement('button', 'icon-button');
        button.appendChild(makeOpenIcon());
    }
    button.title = kind === 'file' ? 'Open in editor' : 'Show in Explorer';
    button.dataset.path = path;
    button.dataset.kind = kind;
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

// which rows in the sidebar's lists are open, as the list's title and the row's id; forgotten when the selection changes
const openLinkRows = new Set<string>();

// the box the open rows belong to
let openLinkRowsFor: string | undefined = undefined;

/**
 * Adds a titled list of what the selected box connects to, grouped the way its arrows are, most imports first; a
 * folder row opens to what's inside it, and clicking a row jumps to it.
 * @param sidebar The sidebar element.
 * @param title The section title.
 * @param groups The rows, from groupLinks or groupInside.
 * @param options A box name for the title, a hint for it, a box to show paths from, and import lines; all optional.
 */
function addConnectionList(sidebar: HTMLElement, title: string, groups: LinkGroup[], options: ListOptions = {}): void {
    const relativeTo = options.relativeTo;
    const lines = options.lines;

    const heading = makeElement('div', 'sidebar-section', title);
    if (options.name !== undefined) {
        const name = makeElement('span', 'sidebar-section-name', ' ' + options.name);
        heading.appendChild(name);
    }
    if (options.hint !== undefined) {
        heading.title = options.hint;
    }
    sidebar.appendChild(heading);

    if (groups.length === 0) {
        const empty = makeElement('div', 'sidebar-empty', 'None');
        sidebar.appendChild(empty);
        return;
    }

    // top rows by their path (from the box they're inside, if any), so it's clear where they are; rows inside them by
    // name, indented under them
    function topRowText(id: string): string {
        if (relativeTo === undefined) {
            return id;
        }
        return pathInside(relativeTo, id) ?? id;
    }
    function addRows(rows: LinkGroup[], level: number): void {
        for (const row of rows) {
            const key = title + ' ' + (options.name ?? '') + '\n' + row.id;
            const text = level === 0 ? topRowText(row.id) : view.info!.nodesById.get(row.id)!.name;
            const rowLines = lines?.get(row.id) ?? [];
            const canOpen = row.children.length > 0 || rowLines.length > 0;
            sidebar.appendChild(makeLinkRow(row, text, level, key, canOpen));
            if (openLinkRows.has(key)) {
                addRows(row.children, level + 1);
                for (const line of rowLines) {
                    sidebar.appendChild(makeImportLineRow(line, level + 1));
                }
            }
        }
    }
    addRows(groups, 0);
}

/**
 * Makes one sidebar row: a toggle if it has rows inside it, its name, how many imports go through it, and a button to
 * open it. Clicking the row jumps to it; clicking the toggle opens or closes it without jumping.
 * @param row The row, from groupLinks.
 * @param text What the row says.
 * @param level How deep it sits in the list, for its indent.
 * @param key Which row it is, for remembering whether it's open.
 * @param canOpen Whether it has anything under it to open: rows inside it, or places its import is written.
 * @returns The row.
 */
function makeLinkRow(row: LinkGroup, text: string, level: number, key: string, canOpen: boolean): HTMLElement {
    const link = makeElement('div', 'sidebar-link');
    link.title = row.id; // the full path on hover
    link.dataset.id = row.id;
    link.addEventListener('click', handleConnectionClick);

    // an empty spot for rows with nothing inside, so names line up
    const toggle = makeRowToggle(level);
    if (canOpen) {
        toggle.textContent = openLinkRows.has(key) ? '▾' : '▸';
        // a file row opens to its import lines; a folder row to what's inside it
        if (row.children.length === 0) {
            toggle.title = 'See lines imported';
        }
        function flip(event: MouseEvent): void {
            event.stopPropagation();
            if (openLinkRows.has(key)) {
                openLinkRows.delete(key);
            } else {
                openLinkRows.add(key);
            }
            drawSidebar();
        }
        toggle.addEventListener('click', flip);
    }
    link.appendChild(toggle);

    const textElement = makeElement('span', 'sidebar-link-text', text);
    link.appendChild(textElement);

    const count = makeElement('span', 'sidebar-count', String(row.count));
    count.title = row.count === 1 ? '1 import' : row.count + ' imports';
    link.appendChild(count);

    const node = view.info!.nodesById.get(row.id)!;
    link.appendChild(makeOpenButton(node.path, node.kind));

    return link;
}

/**
 * Makes the spot at the start of a sidebar row where its open arrow goes. The indent is part of it, so clicking left
 * of the arrow opens the row instead of jumping.
 * @param level How deep the row sits in the list.
 * @returns The element, empty.
 */
function makeRowToggle(level: number): HTMLElement {
    const toggle = makeElement('span', 'sidebar-toggle');
    toggle.style.paddingLeft = (level * 16) + 'px';
    return toggle;
}

/**
 * Makes a row for one place an import is written. Clicking it opens that file with the line selected.
 * @param line Where the import is.
 * @param level How deep it sits in the list, for its indent.
 * @returns The row.
 */
function makeImportLineRow(line: ImportLine, level: number): HTMLElement {
    const row = makeElement('div', 'sidebar-link sidebar-line');
    row.title = 'Open ' + line.path + ' at line ' + line.lines.start;

    // an empty spot where a toggle would be, so it lines up with the rows above
    row.appendChild(makeRowToggle(level));

    const text = makeElement('span', 'sidebar-link-text', line.label);
    row.appendChild(text);

    function open(): void {
        vscode.postMessage({ type: 'open', path: line.path, kind: 'file', lines: line.lines });
    }
    row.addEventListener('click', open);
    return row;
}

/**
 * Selects the node a sidebar row names, opening the boxes around it and turning each to the right page, so it can be
 * seen.
 * @param event The browser's mouse event. Its currentTarget is the row, which carries the node's id.
 */
function handleConnectionClick(event: MouseEvent): void {
    const id = (event.currentTarget as HTMLElement).dataset.id!;
    showNode(view.state, view.info!, id);
    view.selectedId = id;
    view.selectedEdge = undefined;
    redraw();
    centerOn(id);
}

/**
 * Clears the selection, which hides the sidebar.
 */
function handleSidebarClose(): void {
    view.selectedId = undefined;
    view.selectedEdge = undefined;
    redraw();
}
