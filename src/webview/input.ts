import { ROOT_ID } from '../graph/types';
import { dragTo, dropAt } from '../layout/drop';
import { Position, Size } from '../layout/geometry';
import { arrangeShown, boxSize, closeNode, copyLayoutState, LayoutState, openNode, resizeTo, StripSide, turnPage } from '../layout/state';
import { isOnOverlay } from './dom';
import { clearSelectionIfClosedAway } from './sidebar';
import { redraw, view, vscode } from './view';
import { applyCamera } from './viewport';

// presses, drags and clicks on the graph: panning, moving and resizing boxes, selecting, and opening

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

    // the root is around everything, so there's nothing to drag it within
    if (box === null || box.dataset.id !== view.selectedId || view.selectedId === ROOT_ID) {
        return false;
    }
    return !box.classList.contains('open') || target.closest('.box-title') !== null;
}

/**
 * Notes a press that may become a pan: anywhere but the floating panels, a box's arrow, or the selected box's grab
 * area. Panning only starts once the mouse moves, so a press without movement stays a click.
 * @param event The browser's pointer event.
 */
export function handlePointerDown(event: PointerEvent): void {
    pressStart = { x: event.clientX, y: event.clientY };

    const target = event.target as Element;
    // a page number opens its own list, so pressing it neither drags nor pans
    if (isOnOverlay(event) || target.closest('.chevron') !== null || target.closest('.page-counter') !== null) {
        return;
    }

    // the corner handle resizes; checked first, since it sits on the box's grab area
    const handleBox = target.closest('.resize-handle')?.closest<HTMLElement>('.box');
    if (handleBox && view.info !== undefined) {
        const id = handleBox.dataset.id!;
        resize = { id: id, startSize: boxSize(view.state, view.info, id), startMouse: pressStart };
        return;
    }

    // the selected box's grab area moves the box; anywhere else may become a pan
    if (isOnGrabArea(target) && view.selectedId !== undefined) {
        // where it's drawn among its siblings, which isn't its home when a sibling has grown or the directory is
        // squished; the drop works from this, so the box lands where it was let go
        const parentId = view.info!.nodesById.get(view.selectedId)!.parent!;
        const drawn = arrangeShown(view.state, view.info!, parentId).rects.get(view.selectedId)!;
        drag = { id: view.selectedId, startDrawn: { x: drawn.x, y: drawn.y }, startMouse: pressStart, startState: copyLayoutState(view.state) };
        return;
    }

    panLast = { x: event.clientX, y: event.clientY };
}

/**
 * Moves the world along with the mouse, once a press has moved past CLICK_SLOP.
 * @param event The browser's pointer event.
 */
export function handlePointerMove(event: PointerEvent): void {
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
        capturePointer(event, 'panning');
    }

    view.camera = { x: view.camera.x + event.clientX - panLast.x, y: view.camera.y + event.clientY - panLast.y, scale: view.camera.scale };
    panLast = { x: event.clientX, y: event.clientY };
    applyCamera();
}

/**
 * Once a press really is a pan, drag or resize, sends every move to the page even if the mouse leaves the panel, and
 * marks the page with a class, for its cursor. Removing the class is up to whatever ends it.
 * @param event The browser's pointer event that crossed CLICK_SLOP.
 * @param className 'panning', 'dragging' or 'resizing'.
 */
function capturePointer(event: PointerEvent, className: string): void {
    document.body.setPointerCapture(event.pointerId);
    document.body.classList.add(className);
}

/**
 * Ends the press, and the pan if there was one.
 */
export function handlePointerUp(): void {
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
        if (wasDragging && view.info !== undefined) {
            const target = { x: dropped.startDrawn.x + dragOffset.x, y: dropped.startDrawn.y + dragOffset.y };
            view.state = copyLayoutState(dropped.startState);
            dropAt(view.state, view.info, dropped.id, target);
            redraw();
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
    if (view.info === undefined || resize === undefined) {
        return;
    }

    const dx = event.clientX - resize.startMouse.x;
    const dy = event.clientY - resize.startMouse.y;

    if (!isResizing) {
        if (Math.hypot(dx, dy) <= CLICK_SLOP) {
            return;
        }
        isResizing = true;
        capturePointer(event, 'resizing');
    }

    // screen pixels to world pixels, measured from the start so small steps can't add up to drift
    resizeTo(view.state, view.info, resize.id, { width: resize.startSize.width + dx / view.camera.scale, height: resize.startSize.height + dy / view.camera.scale });
    redraw();
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
    if (view.info === undefined || drag === undefined) {
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
        capturePointer(event, 'dragging');
    }

    // screen pixels to world pixels, so the box stays under the mouse at any zoom; measured from the start of the
    // drag, so small steps can't add up to drift
    let offsetX = dx / view.camera.scale;
    let offsetY = dy / view.camera.scale;

    // it can't go past its directory's left or top edge, the same limit moveTo keeps on drop
    offsetX = Math.max(offsetX, -drag.startDrawn.x);
    offsetY = Math.max(offsetY, -drag.startDrawn.y);

    // the home moves and the directory grows to hold it, starting over from before the drag each time, so a long
    // drag can't build up drift; nothing is pushed until the drop
    dragOffset = { x: offsetX, y: offsetY };
    const target = { x: drag.startDrawn.x + offsetX, y: drag.startDrawn.y + offsetY };
    view.state = copyLayoutState(drag.startState);
    dragTo(view.state, view.info, drag.id, target);
    redraw();
}

/**
 * Handles a click: the arrow on a box opens or closes it, anywhere else on a box selects it,
 * and empty space clears the selection.
 * @param event The browser's mouse event.
 */
export function handleClick(event: MouseEvent): void {
    if (isOnOverlay(event)) {
        return;
    }
    if (view.flowView !== undefined) {
        const flowBox = (event.target as Element).closest<HTMLElement>('.flow-node');
        if (flowBox?.dataset.path) {
            vscode.postMessage({ type: 'open', path: flowBox.dataset.path, kind: 'file' });
        }
        return;
    }
    if (view.info === undefined) {
        return;
    }

    // moved too far: this was a drag, not a click
    const moved = Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y);
    if (moved > CLICK_SLOP) {
        return;
    }

    const target = event.target as Element;
    const strip = target.closest<HTMLElement>('.strip');
    if (strip !== null) {
        view.selectedEdge = undefined;
        const ownerId = strip.dataset.ownerId!;
        const side = strip.dataset.side as StripSide;
        turnPage(view.state, view.info, ownerId, side);
        redraw();
        return;
    }
    const box = target.closest<HTMLElement>('.box');
    let id = box?.dataset.id;

    // the root's empty inside is the canvas, so a click there clears the selection; its title selects it
    if (id === ROOT_ID && target.closest('.box-title') === null) {
        id = undefined;
    }

    // empty space, or the "+N more" box, which has no node
    if (id === undefined) {
        view.selectedId = undefined;
        view.selectedEdge = undefined;
    } else if (target.closest('.chevron') !== null) {
        // opened or closed by hand, so it's the user's now, and jumps leave it alone
        view.state.jumpOpened.delete(id);
        if (view.state.expanded.has(id)) {
            closeNode(view.state, view.info, id);
            clearSelectionIfClosedAway();
        } else {
            openNode(view.state, view.info, id);
        }
    } else {
        view.selectedId = id;
        view.selectedEdge = undefined;
    }

    redraw();
}

/**
 * Finds the box being dragged, for drawing: it paints above everything, and its arrows to what's under it are left out.
 * @returns Its id, or undefined unless a press on it has moved past CLICK_SLOP.
 */
export function draggedId(): string | undefined {
    if (!isDragging || drag === undefined) {
        return undefined;
    }
    return drag.id;
}
