import { Camera } from '../layout/camera';
import { Rect } from '../layout/geometry';
import { VisibleEdge } from '../layout/place';
import { EdgeKind } from '../graph/types';
import { ArrowMode, ARROW_KINDS } from '../layout/saved';
import { createLayoutState, GraphInfo, LayoutState } from '../layout/state';
import { FlowGraphMessage, WebviewToExtension } from '../messages';

// what the webview's files share: the connection to the extension, what's shown and how, and a way to redraw it

// VS Code provides this once per webview; calling it a second time throws
declare function acquireVsCodeApi(): { postMessage(message: WebviewToExtension): void };
export const vscode = acquireVsCodeApi();

// everything about what's on screen that more than one file reads or changes
interface View {
    // the current graph's lookups, and what's open and where; info is undefined until a graph arrives
    info: GraphInfo | undefined;
    state: LayoutState;

    // the node whose details the sidebar shows, or undefined when nothing is selected
    selectedId: string | undefined;
    selectedEdge: VisibleEdge | undefined;
    flowView: FlowGraphMessage | undefined;

    // every box drawn last time, so Fit to view can measure what's on screen
    lastRects: Map<string, Rect>;
    // every arrow drawn last time, so the sidebar can list what the selected one stands for
    lastEdges: VisibleEdge[];

    // how strongly arrows draw, from the arrow settings; saved with the layout
    arrowMode: ArrowMode;
    // how many levels below the folder an arrow lives in its ends may go, from the arrow settings; saved with the layout
    arrowDepth: number;
    // the kinds of arrows the user turned off in the arrow settings; saved with the layout
    hiddenKinds: Set<EdgeKind>;

    // how the world is shown; kept between redraws so new data doesn't reset the view
    camera: Camera;
}

export const view: View = {
    info: undefined,
    state: createLayoutState(),
    selectedId: undefined,
    selectedEdge: undefined,
    flowView: undefined,
    lastRects: new Map(),
    lastEdges: [],
    arrowMode: 'default',
    arrowDepth: 1,
    hiddenKinds: new Set(),
    camera: { x: 0, y: 0, scale: 1 },
};

// draws the graph again from the view; main.ts sets it to its drawGraph, so the files it imports can redraw without
// importing it back
let drawGraphFunction: () => void = function notReadyYet(): void {};

/**
 * Sets what redraw calls. main.ts does this once, when the webview starts.
 * @param draw The function that draws the graph.
 */
export function setRedraw(draw: () => void): void {
    drawGraphFunction = draw;
}

/**
 * Draws every visible box and arrow again from the current view, replacing whatever was drawn before.
 */
export function redraw(): void {
    drawGraphFunction();
}

/**
 * Checks whether the graph has any links of a kind. Before a graph arrives, every kind counts.
 * @param kind The kind.
 * @returns True if some edge in the graph is of that kind.
 */
export function hasKind(kind: EdgeKind): boolean {
    return view.info === undefined || view.info.kindsPresent.has(kind);
}

/**
 * Finds which kinds of links show, as arrows and in the sidebar: the ones the graph has that the user hasn't turned
 * off.
 * @returns Those kinds, in the arrow settings' order.
 */
export function shownKinds(): Set<EdgeKind> {
    const shown = new Set<EdgeKind>();
    for (const kind of ARROW_KINDS) {
        if (hasKind(kind) && !view.hiddenKinds.has(kind)) {
            shown.add(kind);
        }
    }
    return shown;
}
