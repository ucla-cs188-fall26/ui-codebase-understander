import { Position, Rect } from './geometry';

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

/**
 * Picks the camera that shows all of some content, centered, with a margin around it.
 * @param content The area to show, in world pixels, like the bounds of every box.
 * @param viewport The part of the screen to show it in, in screen pixels.
 * @param margin Space to leave between the content and the viewport's edges, in screen pixels.
 * @returns The camera. It zooms out as far as needed (down to MIN_SCALE) but never in past 1.
 */
export function fitCamera(content: Rect, viewport: Rect, margin: number): Camera {
	const availableWidth = viewport.width - 2 * margin;
	const availableHeight = viewport.height - 2 * margin;

	// the smaller ratio, so the content fits both ways; never enlarged, since a small graph is fine at full size
	const fittingScale = Math.min(availableWidth / content.width, availableHeight / content.height);
	const scale = Math.min(1, Math.max(MIN_SCALE, fittingScale));

	// put the content's center at the viewport's center
	const contentCenterX = content.x + content.width / 2;
	const contentCenterY = content.y + content.height / 2;
	const viewportCenterX = viewport.x + viewport.width / 2;
	const viewportCenterY = viewport.y + viewport.height / 2;

	return {
		x: viewportCenterX - contentCenterX * scale,
		y: viewportCenterY - contentCenterY * scale,
		scale: scale,
	};
}
