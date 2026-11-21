import { Rect } from '../layout/geometry';

// small helpers for making the panel's elements

/**
 * Makes an element with a class and text, the way most of the panel's pieces start.
 * @param tag The element's tag.
 * @param className Its classes; empty for none.
 * @param text Its text; empty for none.
 * @returns The element, not on the page yet.
 */
export function makeElement<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className = '', text = ''): HTMLElementTagNameMap[Tag] {
    const element = document.createElement(tag);
    if (className !== '') {
        element.className = className;
    }
    if (text !== '') {
        element.textContent = text;
    }
    return element;
}

/**
 * Makes a button that's just an icon, with what it does shown on hover.
 * @param icon The icon, from icons.ts.
 * @param title What the button does.
 * @param onClick What clicking it does.
 * @returns The button.
 */
export function makeIconButton(icon: SVGSVGElement, title: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
    const button = makeElement('button', 'icon-button');
    button.title = title;
    button.appendChild(icon);
    button.addEventListener('click', onClick);
    return button;
}

/**
 * Positions an element absolutely over a rect.
 * @param element The element.
 * @param rect Where it goes, in pixels.
 */
export function placeAt(element: HTMLElement, rect: Rect): void {
    element.style.left = rect.x + 'px';
    element.style.top = rect.y + 'px';
    element.style.width = rect.width + 'px';
    element.style.height = rect.height + 'px';
}

/**
 * Makes a gray button with an icon and a label, like VS Code's secondary buttons.
 * @param icon The icon, from icons.ts.
 * @param label The words on the button.
 * @returns The button, with no click handler yet.
 */
export function makeTextButton(icon: SVGSVGElement, label: string): HTMLButtonElement {
    const button = makeElement('button', 'text-button');
    button.appendChild(icon);
    button.append(label);
    return button;
}

/**
 * Checks whether an event happened on a floating panel, which handles its own
 * clicks and scrolling.
 * @param event Any browser event.
 * @returns True if its target is in either.
 */
export function isOnOverlay(event: Event): boolean {
    // the path is recorded when the event starts, so it still holds the sidebar
    // even if a redraw has since removed the element that was clicked
    const path = event.composedPath();
    return path.includes(document.getElementById('sidebar')!)
        || path.includes(document.getElementById('toolbar')!)
        || path.includes(document.getElementById('page-menu')!)
        || path.includes(document.getElementById('flow-results')!)
        || path.includes(document.getElementById('flow-description')!);
}
