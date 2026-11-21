import * as assert from 'assert';
import { buildTree } from '../graph/build';
import { overlapsWithGap } from '../layout/geometry';
import { arrangeShown, boxSize, buildGraphInfo, CHILD_LIMIT, childOrigin, closeNode, createLayoutState, GraphInfo, LayoutState, HEADER, openNode, PADDING, hiddenSides, listPages, resetNode, resizeTo, showNode, turnPage, turnToPage } from '../layout/state';
import { placeBoxes, placeStrips } from '../layout/place';
import { dropAt } from '../layout/drop';
import { Edge, ROOT_ID } from '../graph/types';
import { makeInfo } from './helpers';

suite('pages', () => {
    // a directory with some files and, at the top level, a file below it; nothing imports anything, so the directory's
    // files stack in one column, and its first page holds the first CHILD_LIMIT of them
    function makeFolder(fileCount: number) {
        const paths: string[] = ['q.ts'];
        for (let i = 1; i <= fileCount; i++) {
            paths.push('p/f' + (i + 10) + '.ts');
        }
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: [] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'p');
        return { info: info, state: state };
    }

    test('opening a directory gives every child a home, and shows the first page', () => {
        const { info, state } = makeFolder(7);

        const shown = arrangeShown(state, info, 'p');

        for (const id of info.childrenById.get('p')!) {
            assert.ok(state.homes.has(id));
        }
        assert.strictEqual(shown.rects.size, CHILD_LIMIT);
        assert.strictEqual(shown.hidden.bottom.length, 2);
    });

    test('clicking the bottom strip turns to the next page, and the first page waits behind a top strip', () => {
        const { info, state } = makeFolder(7);
        const homesBefore = new Map(state.homes);

        turnPage(state, info, 'p', 'bottom');
        const shown = arrangeShown(state, info, 'p');

        assert.deepStrictEqual(Array.from(shown.rects.keys()).toSorted(), ['p/f16.ts', 'p/f17.ts']);
        assert.strictEqual(shown.hidden.top.length, CHILD_LIMIT);
        assert.deepStrictEqual(shown.hidden.bottom, []);
        // turning the page moves nothing inside the directory
        for (const id of info.childrenById.get('p')!) {
            assert.deepStrictEqual(state.homes.get(id), homesBefore.get(id));
        }
    });

    test('draws the next page from the top-left of the directory', () => {
        const { info, state } = makeFolder(7);

        turnPage(state, info, 'p', 'bottom');
        const shown = arrangeShown(state, info, 'p');

        let top = Infinity;
        for (const rect of shown.rects.values()) {
            top = Math.min(top, rect.y);
        }
        assert.ok(top >= 0);
        assert.ok(top < state.pages.get('p')!.size.height);
    });

    test('every page holds as many boxes as the first, with no gap at its top', () => {
        const { info, state } = makeFolder(10);

        turnPage(state, info, 'p', 'bottom');
        const shown = arrangeShown(state, info, 'p');

        assert.strictEqual(shown.rects.size, CHILD_LIMIT);
        let top = Infinity;
        for (const rect of shown.rects.values()) {
            top = Math.min(top, rect.y);
        }
        assert.strictEqual(top, 0);
    });

    test('draws a page from its first box, even after a box on an earlier page grew and pushed it down', () => {
        const { info, state } = makeFolder(10);

        // the first file grows tall, which pushes every file below it down, the second page's too
        resizeTo(state, info, 'p/f11.ts', { width: boxSize(state, info, 'p/f11.ts').width, height: 400 });
        turnPage(state, info, 'p', 'bottom');
        let top = Infinity;
        for (const rect of arrangeShown(state, info, 'p').rects.values()) {
            top = Math.min(top, rect.y);
        }

        assert.strictEqual(top, 0);
    });

    test('clicking the top strip turns back', () => {
        const { info, state } = makeFolder(7);
        turnPage(state, info, 'p', 'bottom');

        turnPage(state, info, 'p', 'top');
        const shown = arrangeShown(state, info, 'p');

        assert.strictEqual(shown.rects.size, CHILD_LIMIT);
        assert.deepStrictEqual(shown.hidden.top, []);
    });

    test('turning a page keeps the directory\'s size, so nothing around it moves', () => {
        const { info, state } = makeFolder(7);
        const sizeBefore = boxSize(state, info, 'p');
        const homeBefore = state.homes.get('q.ts')!;

        // the second page has only two boxes, but the directory stays the size of a page
        turnPage(state, info, 'p', 'bottom');

        assert.deepStrictEqual(boxSize(state, info, 'p'), sizeBefore);
        assert.deepStrictEqual(state.homes.get('q.ts'), homeBefore);
    });

    test('a child dropped far past the page\'s edge stays on its page, and the directory grows', () => {
        const { info, state } = makeFolder(7);
        const before = boxSize(state, info, 'p');

        dropAt(state, info, 'p/f11.ts', { x: 0, y: 5000 });

        assert.ok(arrangeShown(state, info, 'p').rects.has('p/f11.ts'));
        assert.ok(boxSize(state, info, 'p').height > before.height);
    });

    test('lists the pages with children in reading order, marking the current one', () => {
        const { info, state } = makeFolder(7);

        const pages = listPages(state, info, 'p');

        assert.strictEqual(pages.length, 2);
        assert.ok(pages[0].isCurrent && !pages[1].isCurrent);
        assert.strictEqual(pages[0].childIds.length, CHILD_LIMIT);
        assert.deepStrictEqual(pages[1].childIds, ['p/f16.ts', 'p/f17.ts']);
        turnPage(state, info, 'p', 'bottom');
        assert.ok(listPages(state, info, 'p')[1].isCurrent);
    });

    test('lists pages row by row, left to right, and leaves out empty ones', () => {
        const { info, state } = makeFolder(7);

        // a child two columns over: the empty column between isn't listed
        state.childPages.set('p/f17.ts', { column: 2, row: 0 });
        const cells: string[] = [];
        for (const page of listPages(state, info, 'p')) {
            cells.push(page.cell.column + ',' + page.cell.row);
        }

        assert.deepStrictEqual(cells, ['0,0', '2,0', '0,1']);
    });

    test('picking a page from the list turns straight to it, keeping the size', () => {
        const { info, state } = makeFolder(7);
        const sizeBefore = boxSize(state, info, 'p');

        turnToPage(state, info, 'p', listPages(state, info, 'p')[1].cell);

        assert.deepStrictEqual(Array.from(arrangeShown(state, info, 'p').rects.keys()).toSorted(), ['p/f16.ts', 'p/f17.ts']);
        assert.deepStrictEqual(boxSize(state, info, 'p'), sizeBefore);
    });

    test('lists one page when everything fits', () => {
        const { info, state } = makeFolder(3);

        assert.strictEqual(listPages(state, info, 'p').length, 1);
    });

    test('showing a node on a later page turns its directory to that page', () => {
        const { info, state } = makeFolder(7);

        showNode(state, info, 'p/f17.ts');

        assert.ok(arrangeShown(state, info, 'p').rects.has('p/f17.ts'));
    });

    test('showing a node opens every closed directory around it', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);

        showNode(state, info, 'src/lib/b.ts');

        assert.ok(state.expanded.has('src') && state.expanded.has('src/lib'));
        assert.ok(arrangeShown(state, info, 'src/lib').rects.has('src/lib/b.ts'));
    });

    test('resetting the directory puts it back on its first page', () => {
        const { info, state } = makeFolder(7);
        turnPage(state, info, 'p', 'bottom');

        resetNode(state, info, 'p');
        const shown = arrangeShown(state, info, 'p');

        assert.strictEqual(shown.rects.size, CHILD_LIMIT);
        assert.strictEqual(shown.hidden.bottom.length, 2);
    });
});

suite('resizing pages', () => {
    // seven files in one column; the first page holds the first CHILD_LIMIT
    function makeFolder() {
        const paths: string[] = [];
        for (let i = 1; i <= 7; i++) {
            paths.push('p/f' + (i + 10) + '.ts');
        }
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: [] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'p');
        return { info: info, state: state };
    }

    test('making a directory bigger shows more children, at full spacing', () => {
        const { info, state } = makeFolder();
        const fits = boxSize(state, info, 'p');

        resizeTo(state, info, 'p', { width: fits.width, height: fits.height + 1000 });
        const shown = arrangeShown(state, info, 'p');

        assert.strictEqual(shown.rects.size, 7);
        assert.deepStrictEqual(shown.hidden.bottom, []);
        for (const [id, rect] of shown.rects) {
            assert.strictEqual(rect.y, state.homes.get(id)!.y);
        }
    });

    test('making it a little smaller squishes the page, keeping its children', () => {
        const { info, state } = makeFolder();
        const fits = boxSize(state, info, 'p');

        resizeTo(state, info, 'p', { width: fits.width, height: fits.height - 20 });
        const shown = arrangeShown(state, info, 'p');

        assert.strictEqual(shown.rects.size, CHILD_LIMIT);
        assert.strictEqual(shown.hidden.bottom.length, 2);
    });

    test('making it much smaller moves children to the next page, so a strip only ever holds other pages', () => {
        const { info, state } = makeFolder();
        const fits = boxSize(state, info, 'p');

        resizeTo(state, info, 'p', { width: fits.width, height: 0 });
        const shown = arrangeShown(state, info, 'p');

        assert.strictEqual(shown.rects.size, 1);
        assert.strictEqual(shown.hidden.bottom.length, 6);
        assert.deepStrictEqual(shown.hidden.bottom.toSorted(), hiddenSides(state, info, 'p').bottom.toSorted());
    });

    test('a box moved on a page stays where it was put after turning away and back', () => {
        const { info, state } = makeFolder();

        // small enough that the first page holds only f11, which is then dragged right and down
        resizeTo(state, info, 'p', { width: 400, height: 0 });
        dropAt(state, info, 'p/f11.ts', { x: 150, y: 20 });

        turnPage(state, info, 'p', 'bottom');
        turnPage(state, info, 'p', 'top');

        const rect = arrangeShown(state, info, 'p').rects.get('p/f11.ts')!;
        assert.deepStrictEqual({ x: rect.x, y: rect.y }, { x: 150, y: 20 });
    });

    test('a box moved on a page stays where it was put when the directory is resized', () => {
        const { info, state } = makeFolder();
        resizeTo(state, info, 'p', { width: 400, height: 0 });
        dropAt(state, info, 'p/f11.ts', { x: 150, y: 20 });

        const size = boxSize(state, info, 'p');
        resizeTo(state, info, 'p', { width: size.width + 5, height: size.height });

        const rect = arrangeShown(state, info, 'p').rects.get('p/f11.ts')!;
        assert.deepStrictEqual({ x: rect.x, y: rect.y }, { x: 150, y: 20 });
    });

    test('a directory can be resized back to exactly the size it opened at', () => {
        const { info, state } = makeFolder();
        const opened = boxSize(state, info, 'p');

        resizeTo(state, info, 'p', { width: opened.width + 200, height: opened.height + 200 });
        resizeTo(state, info, 'p', opened);

        // its pages only ever have a strip below, so the minimum keeps no room beside it
        assert.deepStrictEqual(boxSize(state, info, 'p'), opened);
    });

    test('growing back undoes shrinking exactly', () => {
        const { info, state } = makeFolder();
        const fits = boxSize(state, info, 'p');
        const pagesBefore = new Map(state.childPages);

        resizeTo(state, info, 'p', { width: fits.width, height: 0 });
        resizeTo(state, info, 'p', fits);

        for (const id of info.childrenById.get('p')!) {
            assert.deepStrictEqual(state.childPages.get(id), pagesBefore.get(id));
        }
    });

    test('resizing keeps the page\'s top-left where it was', () => {
        const { info, state } = makeFolder();
        turnPage(state, info, 'p', 'bottom');
        const fits = boxSize(state, info, 'p');

        resizeTo(state, info, 'p', { width: fits.width, height: fits.height + 1000 });
        const shown = arrangeShown(state, info, 'p');

        // still showing from the second page's first box down, not back at the first page
        assert.ok(shown.rects.has('p/f16.ts') && shown.rects.has('p/f17.ts'));
        assert.ok(!shown.rects.has('p/f11.ts'));
        assert.strictEqual(shown.rects.get('p/f16.ts')!.y, 0);
    });

    // checks every child a directory shows is inside its padding and clear of its strips; sizes that grew by adding
    // and taking away can be a tiny rounding error off, so the inside is that much bigger
    function assertShownFit(state: LayoutState, info: GraphInfo, id: string): void {
        const rects = placeBoxes(state, info, { x: 0, y: 0 });
        const box = rects.get(id)!;
        const rounding = 0.001;
        const inside = { x: box.x + PADDING - rounding, y: box.y + HEADER + PADDING - rounding, width: box.width - 2 * PADDING + 2 * rounding, height: box.height - HEADER - 2 * PADDING + 2 * rounding };
        const strips = placeStrips(state, info, rects).filter(function isOwn(strip) {
            return strip.ownerId === id;
        });
        for (const childId of arrangeShown(state, info, id).rects.keys()) {
            const rect = rects.get(childId)!;
            assert.ok(rect.x >= inside.x && rect.x + rect.width <= inside.x + inside.width, childId + ' sticks out sideways');
            assert.ok(rect.y >= inside.y && rect.y + rect.height <= inside.y + inside.height, childId + ' sticks out up or down');
            for (const strip of strips) {
                assert.ok(!overlapsWithGap(rect, strip.rect, 0), childId + ' is under the ' + strip.side + ' strip');
            }
        }
    }

    // a chain of files through a directory; the last file is imported twice, so it sits a little higher than the rest,
    // and none of the first four start at the very top
    function makeChain() {
        const paths = ['p/a.ts', 'p/b.ts', 'p/c.ts', 'p/d/x.ts', 'p/e.ts'];
        const edges: Edge[] = [
            { from: 'p/a.ts', to: 'p/b.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'p/b.ts', to: 'p/c.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'p/c.ts', to: 'p/d/x.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'p/d/x.ts', to: 'p/e.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'p/a.ts', to: 'p/e.ts', kind: 'import', lines: { start: 1, end: 1 } },
        ];
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: edges });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'p');
        return { info: info, state: state };
    }

    test('at any size, every page has children and fits the box, and turning to it keeps the size', () => {
        for (const make of [makeFolder, makeChain]) {
            for (const width of [0, 300, 500, 750, 1200]) {
                for (const height of [0, 150, 250, 400]) {
                    const { info, state } = make();
                    resizeTo(state, info, 'p', { width: width, height: height });
                    const size = boxSize(state, info, 'p');

                    for (const page of listPages(state, info, 'p')) {
                        turnToPage(state, info, 'p', page.cell);
                        assert.ok(arrangeShown(state, info, 'p').rects.size > 0, 'an empty page at ' + width + 'x' + height);
                        assertShownFit(state, info, 'p');
                        assert.deepStrictEqual(boxSize(state, info, 'p'), size);
                    }
                }
            }
        }
    });

    // a directory with files around a directory of four files, which is much bigger open than closed
    function makeAroundDirectory() {
        const paths = ['p/a.ts', 'p/b.ts', 'p/c.ts', 'p/d/x.ts', 'p/d/y.ts', 'p/d/z.ts', 'p/d/w.ts', 'p/e.ts'];
        const edges: Edge[] = [
            { from: 'p/a.ts', to: 'p/b.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'p/b.ts', to: 'p/d/x.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'p/a.ts', to: 'p/c.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'p/c.ts', to: 'p/e.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'p/d/x.ts', to: 'p/d/y.ts', kind: 'import', lines: { start: 1, end: 1 } },
        ];
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: edges });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'p');
        return { info: info, state: state };
    }

    test('opening a directory inside a resized one grows it by as much, and closing gives the room back', () => {
        const { info, state } = makeAroundDirectory();
        resizeTo(state, info, 'p', boxSize(state, info, 'p'));
        const before = boxSize(state, info, 'p');
        const closed = boxSize(state, info, 'p/d');

        openNode(state, info, 'p/d');
        const opened = boxSize(state, info, 'p/d');
        assert.ok(Math.abs(boxSize(state, info, 'p').width - (before.width + opened.width - closed.width)) < 0.001);
        assertShownFit(state, info, 'p');

        closeNode(state, info, 'p/d');
        assert.ok(Math.abs(boxSize(state, info, 'p').width - before.width) < 0.001);
        assert.ok(Math.abs(boxSize(state, info, 'p').height - before.height) < 0.001);
    });

    test('opening a directory inside one squished by its corner never moves its siblings to another page', () => {
        const { info, state } = makeAroundDirectory();
        const fits = boxSize(state, info, 'p');
        resizeTo(state, info, 'p', { width: fits.width - 60, height: fits.height - 30 });
        const shown = Array.from(arrangeShown(state, info, 'p').rects.keys()).toSorted();

        openNode(state, info, 'p/d');

        assert.deepStrictEqual(Array.from(arrangeShown(state, info, 'p').rects.keys()).toSorted(), shown);
        assertShownFit(state, info, 'p');
    });

    test('a box dropped onto a spot with a box on another page pushes that one too, so the two never share a page on top of each other', () => {
        const { info, state } = makeFolder();

        // f16 is on the second page, below the first five; drop f11 right where it is
        const hidden = state.homes.get('p/f16.ts')!;
        dropAt(state, info, 'p/f11.ts', hidden);

        const f11 = { x: hidden.x, y: hidden.y, width: boxSize(state, info, 'p/f11.ts').width, height: boxSize(state, info, 'p/f11.ts').height };
        const f16Home = state.homes.get('p/f16.ts')!;
        const f16 = { x: f16Home.x, y: f16Home.y, width: boxSize(state, info, 'p/f16.ts').width, height: boxSize(state, info, 'p/f16.ts').height };
        assert.ok(!overlapsWithGap(f11, f16, 0));
    });

    test('a box on another page shrinking keeps the shown page\'s boxes inside the directory', () => {
        const { info, state } = makeFolder();
        turnPage(state, info, 'p', 'bottom');

        // f11, on the first page, gets shorter, which pulls everything below it up, past where the second page started
        const f11 = boxSize(state, info, 'p/f11.ts');
        resizeTo(state, info, 'p/f11.ts', { width: f11.width, height: f11.height - 10 });

        assertShownFit(state, info, 'p');
    });

    test('resizing never puts children behind a top or left strip the user didn\'t turn to', () => {
        const { info, state } = makeChain();

        // the last file starts a little higher than the rest; cutting from where the first page starts would put the
        // others on a page above it
        resizeTo(state, info, 'p', { width: 0, height: 1000 });
        resizeTo(state, info, 'p', { width: 750, height: 0 });

        const hidden = hiddenSides(state, info, 'p');
        assert.deepStrictEqual(hidden.top, []);
        assert.deepStrictEqual(hidden.left, []);
    });

    test('at its smallest, a box in a row of pages is only as tall as its tallest child, with no room for strips it won\'t have', () => {
        // a chain of files in a row, so pages go across and none has a strip above or below
        const paths = ['p/a.ts', 'p/b.ts', 'p/c.ts', 'p/d.ts'];
        const edges: Edge[] = [
            { from: 'p/a.ts', to: 'p/b.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'p/b.ts', to: 'p/c.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'p/c.ts', to: 'p/d.ts', kind: 'import', lines: { start: 1, end: 1 } },
        ];
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: edges });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'p');

        resizeTo(state, info, 'p', { width: 0, height: 0 });

        let tallest = 0;
        for (const id of paths) {
            tallest = Math.max(tallest, boxSize(state, info, id).height);
        }
        assert.strictEqual(boxSize(state, info, 'p').height, HEADER + PADDING + tallest + PADDING);
        for (const page of listPages(state, info, 'p')) {
            turnToPage(state, info, 'p', page.cell);
            assertShownFit(state, info, 'p');
        }
    });

    test('a page never comes out empty, even when no child starts at the top of the box', () => {
        const { info, state } = makeChain();

        // narrow, then wide enough to take in the directory but not the last file, and too short for the directory
        resizeTo(state, info, 'p', { width: 0, height: 1000 });
        resizeTo(state, info, 'p', { width: 750, height: 0 });

        assert.ok(arrangeShown(state, info, 'p').rects.size > 0);
        assertShownFit(state, info, 'p');
    });
});

suite('resizing inside a directory', () => {
    test('grows a directory the user sized, when a child is made bigger than it', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'src');
        resizeTo(state, info, 'src', boxSize(state, info, 'src'));
        const before = boxSize(state, info, 'src');

        resizeTo(state, info, 'src/a.ts', { width: 100, height: 2000 });

        assert.ok(boxSize(state, info, 'src').height > before.height);
    });

    test('a directory at its smallest still holds every box it shows, after squishing across slides them', () => {
        // a and b share a row; c sits below, between them. Squishing across slides c under b, into b's column
        const info = buildGraphInfo({ nodes: buildTree('repo', ['p/a.ts', 'p/b.ts', 'p/c.ts']), edges: [] });
        const state = createLayoutState();
        state.expanded.add('p');
        state.homes.set('p', { x: 0, y: 0 });
        state.homes.set('p/a.ts', { x: 0, y: 0 });
        state.homes.set('p/b.ts', { x: 300, y: 0 });
        state.homes.set('p/c.ts', { x: 150, y: 60 });
        for (const id of ['p/a.ts', 'p/b.ts', 'p/c.ts']) {
            state.closedSizes.set(id, { width: 100, height: 50 });
        }

        resizeTo(state, info, 'p', { width: 0, height: 0 });

        // the inside ends one padding above the bottom; childOrigin's x is the padding
        const insideHeight = boxSize(state, info, 'p').height - childOrigin(state, info, 'p').y - PADDING;
        for (const rect of arrangeShown(state, info, 'p').rects.values()) {
            assert.ok(rect.y + rect.height <= insideHeight);
        }
    });
});
