import { Camera } from './camera';
import { Position, Size } from './geometry';
import { createLayoutState, GraphInfo, LayoutState, Page, PageCell } from './state';
import { Pushes } from './push';

// how strongly arrows draw, from the toolbar: only the selected box's, the rest faint, or everything in full
export type ArrowMode = 'hidden' | 'default' | 'full';

// the layout state and camera in plain arrays, since messages and VS Code's storage only carry JSON-like data
export interface SavedLayout {
	expanded: string[];
	homes: [string, Position][];
	pages?: [string, Page][]; // missing from layouts saved before directories had pages
	childPages?: [string, PageCell][]; // the same
	jumpOpened?: string[]; // missing from layouts saved before jumps closed what they opened
	closedSizes: [string, Size][];
	openSizes: [string, Size][];
	pushes?: [string, Pushes][]; // missing from layouts saved before boxes remembered their pushes
	owed?: [string, Position][]; // the same
	camera: Camera;
	arrowMode?: ArrowMode; // missing from layouts saved before the setting existed
	arrowDepth?: number; // the same; how many levels below the folder an arrow lives in its ends may go
}

/**
 * Turns the view into plain data that can be sent and stored.
 * @param state The layout state.
 * @param camera The camera.
 * @param arrowMode The toolbar's arrow setting.
 * @param arrowDepth The toolbar's depth setting.
 * @returns The same information, with sets and maps turned into arrays.
 */
export function toSaved(state: LayoutState, camera: Camera, arrowMode: ArrowMode, arrowDepth: number): SavedLayout {
	return {
		expanded: Array.from(state.expanded),
		homes: Array.from(state.homes.entries()),
		pages: Array.from(state.pages.entries()),
		childPages: Array.from(state.childPages.entries()),
		jumpOpened: Array.from(state.jumpOpened),
		closedSizes: Array.from(state.closedSizes.entries()),
		openSizes: Array.from(state.openSizes.entries()),
		pushes: Array.from(state.pushes.entries()),
		owed: Array.from(state.owed.entries()),
		camera: camera,
		arrowMode: arrowMode,
		arrowDepth: arrowDepth,
	};
}

/**
 * Turns saved data back into a view, skipping anything about nodes that no longer exist.
 * @param saved The saved layout.
 * @param info The current graph's lookups.
 * @returns The layout state, camera, arrow setting ('default' if it wasn't saved), and depth setting (1 if it wasn't,
 *   or wasn't a number).
 */
export function fromSaved(saved: SavedLayout, info: GraphInfo): { state: LayoutState; camera: Camera; arrowMode: ArrowMode; arrowDepth: number } {
	// starts with the root open
	const state = createLayoutState();

	// files may have been deleted or renamed since this was saved, so only nodes that still exist come back
	function exists(id: string): boolean {
		return info.nodesById.has(id);
	}
	function restore<T>(entries: [string, T][] | undefined, into: Map<string, T>): void {
		for (const [id, value] of entries ?? []) {
			if (exists(id)) {
				into.set(id, value);
			}
		}
	}
	for (const id of saved.expanded.filter(exists)) {
		state.expanded.add(id);
	}
	for (const id of (saved.jumpOpened ?? []).filter(exists)) {
		state.jumpOpened.add(id);
	}
	restore(saved.homes, state.homes);
	restore(saved.childPages, state.childPages);
	restore(saved.closedSizes, state.closedSizes);
	restore(saved.openSizes, state.openSizes);

	// a box with no pushes saved makes room the usual way the next time it changes size
	restore(saved.pushes, state.pushes);
	restore(saved.owed, state.owed);

	// pages saved before resizing could change them have no anchor or natural size: they were cut from the layout's
	// top-left, at the size they are; ones saved before pages were drawn from their boxes are drawn from their grid
	// corner, until they're next turned to
	for (const [id, page] of saved.pages ?? []) {
		if (exists(id)) {
			const anchor = page.anchor ?? { x: 0, y: 0 };
			const gridCorner = { x: anchor.x + page.column * page.size.width, y: anchor.y + page.row * page.size.height };
			state.pages.set(id, {
				column: page.column,
				row: page.row,
				anchor: anchor,
				size: page.size,
				natural: page.natural ?? page.size,
				drawnFrom: page.drawnFrom ?? gridCorner,
				origins: page.origins ?? {},
			});
		}
	}

	// a layout saved earlier may have 'all' here, from when the depth was picked from a list
	let arrowDepth = 1;
	if (typeof saved.arrowDepth === 'number') {
		arrowDepth = saved.arrowDepth;
	}

	return { state: state, camera: saved.camera, arrowMode: saved.arrowMode ?? 'default', arrowDepth: arrowDepth };
}
