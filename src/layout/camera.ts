import { Position } from './geometry';

// how far you can zoom out and in
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 3;

// how the world is shown on screen: shifted by x and y pixels, then magnified by scale
export interface Camera {
	x: number;
	y: number;
	scale: number;
}

/**
 * Zooms in or out while keeping the point under the mouse in place, the way map apps do.
 * @param camera The camera before zooming.
 * @param pointer The mouse position on screen, in pixels from the panel's top-left.
 * @param factor How much to magnify: above 1 zooms in, below 1 zooms out.
 * @returns The new camera. The scale stays between MIN_SCALE and MAX_SCALE.
 */
export function zoomAt(camera: Camera, pointer: Position, factor: number): Camera {
	// the world point under the mouse right now
	const worldX = (pointer.x - camera.x) / camera.scale;
	const worldY = (pointer.y - camera.y) / camera.scale;

	const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor));

	// shift so that same world point lands back under the mouse
	return {
		x: pointer.x - worldX * scale,
		y: pointer.y - worldY * scale,
		scale: scale,
	};
}
