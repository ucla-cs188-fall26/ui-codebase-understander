import { getLineage } from '../analysis/lookups';
import { ArrowMode } from '../layout/saved';
import { makeElement, makeIconButton } from './dom';
import { makeArrowsIcon, makeFitIcon, makeResetIcon, makeSettingsIcon } from './icons';
import { closePageMenu, closePageMenuOutside } from './pageMenu';
import { redraw, view, vscode } from './view';
import { fitToView } from './viewport';

// the toolbar in the top-left corner and its popups: reset, fit, and the arrow settings

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
    return makeElement('span', 'toolbar-divider');
}

/**
 * Shows the current arrow strength in the arrow settings: its button pressed, the others not.
 */
export function showArrowMode(): void {
    for (const button of document.querySelectorAll<HTMLElement>('.arrow-mode')) {
        button.setAttribute('aria-pressed', String(button.dataset.mode === view.arrowMode));
    }
}

/**
 * Switches to the clicked arrow strength, then redraws, which also saves it.
 * @param event The browser's mouse event, on one of the strength buttons.
 */
function handleArrowModeClick(event: MouseEvent): void {
    const button = event.currentTarget as HTMLElement;
    view.arrowMode = button.dataset.mode as ArrowMode;
    showArrowMode();
    redraw();
}

/**
 * Finds the graph's deepest level, where top-level boxes are 1. At that depth arrows group nothing.
 * @returns The deepest node's depth, or 1 before a graph arrives.
 */
function deepestLevel(): number {
    // a lineage runs from the node up to the root, so it's one longer than the depth
    let deepest = 1;
    if (view.info !== undefined) {
        for (const id of view.info.nodesById.keys()) {
            deepest = Math.max(deepest, getLineage(id, view.info.nodesById).length - 1);
        }
    }
    return deepest;
}

/**
 * Sets up the toolbar's depth field for the current graph: its max, the dimmed "/ max" beside it, and the current
 * setting, pulled down to the max if the repo has got shallower.
 */
export function showArrowDepth(): void {
    const deepest = deepestLevel();
    view.arrowDepth = Math.min(view.arrowDepth, deepest);

    const input = document.getElementById('arrow-depth') as HTMLInputElement;
    input.max = String(deepest);
    input.value = String(view.arrowDepth);
    document.getElementById('arrow-depth-max')!.textContent = String(deepest);
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

    view.arrowDepth = depth;
    input.value = String(depth);
    redraw();
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
        closePageMenu();
    }
}

/**
 * Makes a heading at the top of a toolbar popup.
 * @param text The heading.
 * @returns The element.
 */
export function makePopupHeading(text: string): HTMLElement {
    return makeElement('div', 'popup-heading', text);
}

/**
 * Makes one row of a toolbar popup: a label, then a place for its control.
 * @param label The label.
 * @param title What the setting does, shown on hovering the label; empty for none.
 * @returns The row, and the element to put the control in.
 */
function makePopupRow(label: string, title: string): { row: HTMLElement; control: HTMLElement } {
    const row = makeElement('div', 'popup-row');
    const name = makeElement('span', '', label);
    name.title = title;
    row.appendChild(name);
    const control = makeElement('div', 'popup-control');
    row.appendChild(control);
    return { row: row, control: control };
}

/**
 * Fills in the toolbar in the top-left corner, all icons: reset and fit, then the arrow settings, then a settings
 * button at the end whose popup holds setup that's rarely changed, like the language model. Runs once, since its
 * buttons never change.
 * @returns The settings popup, empty, for that setup to go in.
 */
export function drawToolbar(): HTMLElement {
    const toolbar = document.getElementById('toolbar')!;

    const reset = makeIconButton(makeResetIcon(), 'Reset layout', handleToolbarReset);
    toolbar.appendChild(reset);

    const fit = makeIconButton(makeFitIcon(), 'Fit to view', fitToView);
    toolbar.appendChild(fit);

    // the arrow settings, behind one button: how strongly they draw, and how deep they go
    toolbar.appendChild(makeDivider());
    const arrowsAnchor = makeElement('span', 'popup-anchor');
    toolbar.appendChild(arrowsAnchor);
    const arrowsButton = makeIconButton(makeArrowsIcon(), 'Arrows', toggleArrowsPopup);
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
        const button = makeElement('button', 'text-button arrow-mode');
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
    // the slash and the number are separate, so the row's gap spaces both sides of the slash evenly
    depth.control.classList.add('depth-control');
    const depthSlash = makeElement('span', 'arrow-depth-max', '/');
    depth.control.appendChild(depthSlash);
    const depthMax = document.createElement('span');
    depthMax.id = 'arrow-depth-max';
    depthMax.className = 'arrow-depth-max';
    depth.control.appendChild(depthMax);
    showArrowDepth();

    // the settings button, last, with its popup hanging below it
    toolbar.appendChild(makeDivider());
    const settingsAnchor = makeElement('span', 'popup-anchor');
    toolbar.appendChild(settingsAnchor);
    const settingsButton = makeIconButton(makeSettingsIcon(), 'Settings', toggleSettings);
    settingsAnchor.appendChild(settingsButton);

    const settings = document.createElement('div');
    settings.id = 'settings';
    settings.className = 'popup';
    settingsAnchor.appendChild(settings);
    document.addEventListener('pointerdown', closePopupsOutside);
    document.addEventListener('pointerdown', closePageMenuOutside);
    document.addEventListener('keydown', closePopupsOnEscape);
    return settings;
}

/**
 * Asks the extension to reset the whole layout; it confirms first, since only it can show VS Code's dialogs.
 */
function handleToolbarReset(): void {
    vscode.postMessage({ type: 'requestReset' });
}
