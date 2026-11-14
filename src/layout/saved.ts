import { Camera } from './camera';
import { Position, Size } from './geometry';
import { createLayoutState, GraphInfo, LayoutState } from './state';

// how strongly arrows draw, from the toolbar: only the selected box's, the rest faint, or everything in full
export type ArrowMode = 'hidden' | 'default' | 'full';

// the layout state and camera in plain arrays, since messages and VS Code's storage only carry JSON-like data
export interface SavedLayout {
	expanded: string[];
	shownPastLimit?: string[]; // missing from layouts saved before strips could be clicked
	homes: [string, Position][];
	closedSizes: [string, Size][];
	openSizes: [string, Size][];
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
		shownPastLimit: Array.from(state.shownPastLimit),
		homes: Array.from(state.homes.entries()),
		closedSizes: Array.from(state.closedSizes.entries()),
		openSizes: Array.from(state.openSizes.entries()),
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

	// files may have been deleted or renamed since this was saved
	for (const id of saved.expanded) {
		if (info.nodesById.has(id)) {
			state.expanded.add(id);
		}
	}
	for (const id of saved.shownPastLimit ?? []) {
		if (info.nodesById.has(id)) {
			state.shownPastLimit.add(id);
		}
	}
	for (const [id, home] of saved.homes) {
		if (info.nodesById.has(id)) {
			state.homes.set(id, home);
		}
	}
	for (const [id, size] of saved.closedSizes) {
		if (info.nodesById.has(id)) {
			state.closedSizes.set(id, size);
		}
	}
	for (const [id, size] of saved.openSizes) {
		if (info.nodesById.has(id)) {
			state.openSizes.set(id, size);
		}
	}

	// a layout saved earlier may have 'all' here, from when the depth was picked from a list
	let arrowDepth = 1;
	if (typeof saved.arrowDepth === 'number') {
		arrowDepth = saved.arrowDepth;
	}

	return { state: state, camera: saved.camera, arrowMode: saved.arrowMode ?? 'default', arrowDepth: arrowDepth };
}
