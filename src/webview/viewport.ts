import { Camera, fitCamera, zoomAt } from '../layout/camera';
import { boundsOf } from '../layout/geometry';
import { toSaved } from '../layout/saved';
import { isOnOverlay } from './dom';
import { closePageMenu } from './pageMenu';
import { view, vscode } from './view';

// the camera: panning, zooming and gliding the view, and saving it along with the layout

// room the sidebar card takes on the right, so centering aims at the part of the graph you can see
const SIDEBAR_SPACE = 280 + 24;

// how long the view takes to glide to a box, in milliseconds; matches the transition in the page's CSS
const GLIDE_TIME = 300;

/**
 * Moves the view so a box sits in the middle of the visible area, keeping the zoom.
 * @param id The box to bring into view. Does nothing if it has no box, like a node behind "+N more".
 */
export function centerOn(id: string): void {
    const box = document.querySelector<HTMLElement>('.box[data-id="' + CSS.escape(id) + '"]');
    if (box === null) {
        return;
    }

    // offset values are in world pixels, before the camera's transform
    const boxCenterX = box.offsetLeft + box.offsetWidth / 2;
    const boxCenterY = box.offsetTop + box.offsetHeight / 2;

    const middleX = (window.innerWidth - SIDEBAR_SPACE) / 2;
    const middleY = window.innerHeight / 2;

    glideTo({ x: middleX - boxCenterX * view.camera.scale, y: middleY - boxCenterY * view.camera.scale, scale: view.camera.scale });
}

// space left around everything when fitting it in view, in screen pixels
export const FIT_MARGIN = 40;

/**
 * Moves and zooms the view so every visible box fits in the part of the panel you can see.
 */
export function fitToView(): void {
    const bounds = boundsOf(view.lastRects.values());
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
    view.camera = target;
    document.body.classList.add('gliding');
    applyCamera();
    setTimeout(stopGliding, GLIDE_TIME);
}

/**
 * Turns off the glide animation after glideTo.
 */
function stopGliding(): void {
    document.body.classList.remove('gliding');
}

// how strongly one wheel step zooms; small, because trackpads send many tiny steps
const ZOOM_SPEED = 0.005;

// how far apart the background's dots are at normal zoom, in pixels
const DOT_SPACING = 20;

// how big a background dot is at normal zoom, and never smaller than the second, so it doesn't vanish zoomed out
const DOT_SIZE = 0.6;
const MIN_DOT_SIZE = 0.35;

/**
 * Moves and scales the whole world to match the camera, and the background's dots with it.
 */
export function applyCamera(): void {
    const world = document.getElementById('world')!;
    world.style.transform = 'translate(' + view.camera.x + 'px, ' + view.camera.y + 'px) scale(' + view.camera.scale + ')';

    // the dots move and space out with the world; zoomed far out, every other one is left out so they don't crowd
    let spacing = DOT_SPACING * view.camera.scale;
    while (spacing < DOT_SPACING / 2) {
        spacing *= 2;
    }
    document.body.style.backgroundSize = spacing + 'px ' + spacing + 'px';
    document.body.style.backgroundPosition = view.camera.x + 'px ' + view.camera.y + 'px';
    document.body.style.setProperty('--dot-size', Math.max(MIN_DOT_SIZE, DOT_SIZE * view.camera.scale) + 'px');
    scheduleSave();
}

// how long to wait after the last change before saving, so a pan saves once instead of on every move
const SAVE_DELAY = 500;

// the pending save, so a newer change can push it back
let saveTimer: ReturnType<typeof setTimeout> | undefined = undefined;

/**
 * Saves the layout once changes have paused for SAVE_DELAY.
 */
export function scheduleSave(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLayout, SAVE_DELAY);
}

/**
 * Sends the layout and camera to the extension, which stores them for this workspace.
 */
function saveLayout(): void {
    if (view.info === undefined) {
        return;
    }
    vscode.postMessage({ type: 'saveLayout', layout: toSaved(view.state, view.camera, view.arrowMode, view.arrowDepth) });
}

/**
 * Zooms around the mouse. Scrolling is always zoom, never page scroll.
 * @param event The browser's wheel event.
 */
export function handleWheel(event: WheelEvent): void {
    // the list of pages sits where its page number was, which zooming moves
    closePageMenu();

    // let the sidebar scroll its own lists
    if (isOnOverlay(event)) {
        return;
    }
    event.preventDefault();

    // scrolling up (negative deltaY) zooms in; exp keeps big and tiny steps both smooth
    const factor = Math.exp(-event.deltaY * ZOOM_SPEED);
    view.camera = zoomAt(view.camera, { x: event.clientX, y: event.clientY }, factor);
    applyCamera();
}
