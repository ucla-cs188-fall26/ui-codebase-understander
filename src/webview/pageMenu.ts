import { listPages, PageListing, turnToPage } from '../layout/state';
import { makeElement } from './dom';
import { redraw, view } from './view';

// an open directory's page number, and the list of its pages that clicking it opens

/**
 * Makes the page number in an open directory's title, just after its name: which page it's on, in reading order, out
 * of how many have children. Clicking it lists the pages, to jump to one.
 * @param id The directory.
 * @param pages Its pages, from listPages.
 * @returns The element.
 */
export function makePageCounter(id: string, pages: PageListing[]): HTMLElement {
    let current = 1;
    for (let i = 0; i < pages.length; i++) {
        if (pages[i].isCurrent) {
            current = i + 1;
        }
    }

    const counter = makeElement('button', 'page-counter');
    counter.dataset.id = id;
    counter.textContent = current + '/' + pages.length;
    counter.title = 'Page ' + current + ' of ' + pages.length + '. Click to pick another';
    counter.addEventListener('click', openPageMenu);
    return counter;
}

/**
 * Opens the list of a directory's pages just below its page number, each with the first few names on it, so one can
 * be picked to jump to.
 * @param event The browser's mouse event, on a page number.
 */
function openPageMenu(event: MouseEvent): void {
    // handled here, so the click doesn't also select the box
    event.stopPropagation();
    if (view.info === undefined) {
        return;
    }
    const counter = event.currentTarget as HTMLElement;
    const id = counter.dataset.id!;

    const menu = document.getElementById('page-menu')!;
    menu.replaceChildren();
    const pages = listPages(view.state, view.info, id);
    for (let i = 0; i < pages.length; i++) {
        menu.appendChild(makePageMenuItem(id, pages[i], i + 1));
    }

    // below the page number, where it is on screen now
    const place = counter.getBoundingClientRect();
    menu.style.left = place.left + 'px';
    menu.style.top = (place.bottom + 4) + 'px';
    menu.classList.add('visible');
}

// how many names a page's entry in the list shows before "+N"
const PAGE_MENU_NAMES = 3;

/**
 * Makes one entry in the list of pages: its number, then the first few names on it.
 * @param id The directory.
 * @param page The page.
 * @param number Its number, in reading order.
 * @returns The element.
 */
function makePageMenuItem(id: string, page: PageListing, number: number): HTMLElement {
    const names: string[] = [];
    for (const childId of page.childIds.slice(0, PAGE_MENU_NAMES)) {
        names.push(view.info!.nodesById.get(childId)!.name);
    }
    let text = names.join(', ');
    if (page.childIds.length > PAGE_MENU_NAMES) {
        text += ' +' + (page.childIds.length - PAGE_MENU_NAMES);
    }

    const item = makeElement('button', 'page-menu-item');
    if (page.isCurrent) {
        item.classList.add('current');
    }
    const numberElement = makeElement('span', 'page-menu-number', String(number));
    item.appendChild(numberElement);
    const namesElement = makeElement('span', 'page-menu-names', text);
    item.appendChild(namesElement);

    function pick(): void {
        turnToPage(view.state, view.info!, id, page.cell);
        closePageMenu();
        redraw();
    }
    item.addEventListener('click', pick);
    return item;
}

/**
 * Closes the list of pages.
 */
export function closePageMenu(): void {
    document.getElementById('page-menu')!.classList.remove('visible');
}

/**
 * Closes the list of pages on a press anywhere outside it.
 * @param event The browser's pointer event.
 */
export function closePageMenuOutside(event: PointerEvent): void {
    if (!event.composedPath().includes(document.getElementById('page-menu')!)) {
        closePageMenu();
    }
}
