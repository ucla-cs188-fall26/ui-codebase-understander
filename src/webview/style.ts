import { StyleColors } from '../messages';

// every part of the graph's look a user might want to change, in one place. Colors fall back to the theme, so the
// graph fits any theme; the codeflow.* settings can replace them
export const STYLE = {
	// the accent on folders: a bar down the left edge, and a tint in the title
	folderColor: 'var(--vscode-charts-blue, #3794ff)',
	// a bar down files' left edge, like folders have; none unless the user picks one
	fileColor: 'transparent',
	// arrows and their heads
	arrowColor: 'var(--vscode-editorLineNumber-foreground)',
	// the selected box's border and the selected arrow
	highlightColor: 'var(--vscode-charts-yellow, #e2c08d)',
	// how much lighter (toward the text color) each level of nesting gets, and the most any box gets, in percent
	shadeStep: 4,
	maxShade: 24,
};

/**
 * Puts the style's values on the page as CSS variables, which the page's styles read. A color the user set replaces
 * the default; an empty one keeps it.
 * @param colors The user's color settings; none before the extension sends them.
 */
export function applyStyle(colors?: StyleColors): void {
	function chosen(setting: string | undefined, fallback: string): string {
		if (setting === undefined || setting.trim() === '') {
			return fallback;
		}
		return setting;
	}

	const root = document.documentElement.style;
	root.setProperty('--cf-folder', chosen(colors?.folder, STYLE.folderColor));
	root.setProperty('--cf-file', chosen(colors?.file, STYLE.fileColor));
	root.setProperty('--cf-arrow', chosen(colors?.arrow, STYLE.arrowColor));
	root.setProperty('--cf-highlight', chosen(colors?.highlight, STYLE.highlightColor));
	root.setProperty('--cf-shade-step', STYLE.shadeStep + '%');
	root.setProperty('--cf-max-shade', STYLE.maxShade + '%');
}
