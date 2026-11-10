import { Camera } from './camera';
import { Position, Size } from './geometry';
import { createLayoutState, GraphInfo, LayoutState } from './state';

// the layout state and camera in plain arrays, since messages and VS Code's storage only carry JSON-like data
export interface SavedLayout {
	expanded: string[];
	homes: [string, Position][];
	closedSizes: [string, Size][];
	openSizes: [string, Size][];
	camera: Camera;
}

/**
 * Turns the view into plain data that can be sent and stored.
 * @param state The layout state.
 * @param camera The camera.
 * @returns The same information, with sets and maps turned into arrays.
 */
export function toSaved(state: LayoutState, camera: Camera): SavedLayout {
	return {
		expanded: Array.from(state.expanded),
		homes: Array.from(state.homes.entries()),
		closedSizes: Array.from(state.closedSizes.entries()),
		openSizes: Array.from(state.openSizes.entries()),
		camera: camera,
	};
}

/**
 * Turns saved data back into a view, skipping anything about nodes that no longer exist.
 * @param saved The saved layout.
 * @param info The current graph's lookups.
 * @returns The layout state and camera.
 */
export function fromSaved(saved: SavedLayout, info: GraphInfo): { state: LayoutState; camera: Camera } {
	// starts with the root open
	const state = createLayoutState();

	// files may have been deleted or renamed since this was saved
	for (const id of saved.expanded) {
		if (info.nodesById.has(id)) {
			state.expanded.add(id);
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

	return { state: state, camera: saved.camera };
}
