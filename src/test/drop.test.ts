import * as assert from 'assert';
import { buildTree } from '../graph/build';
import { GAP } from '../layout/defaultLayout';
import { arrangeChildren, arrangeShown, boxSize, buildGraphInfo, copyLayoutState, createLayoutState, defaultSize, moveTo, openNode, resizeTo } from '../layout/state';
import { dragTo, dropAt, settleDrop } from '../layout/drop';
import { ROOT_ID } from '../graph/types';
import { makeInfo } from './helpers';

suite('settleDrop', () => {
    // 100x50 boxes with homes set by hand; paths decide whether they sit at the top level or in a directory
    function makeBoxes(homes: [string, { x: number; y: number }][]) {
        const paths: string[] = [];
        for (const [id] of homes) {
            paths.push(id);
        }
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: [] });
        const state = createLayoutState();
        for (const [id, home] of homes) {
            state.homes.set(id, home);
            state.closedSizes.set(id, { width: 100, height: 50 });
        }
        return { info: info, state: state };
    }

    test('pushes a box right when dropped on its left part, and the dropped box stays put', () => {
        const { info, state } = makeBoxes([['a.ts', { x: 150, y: 0 }], ['b.ts', { x: 200, y: 0 }]]);

        settleDrop(state, info, 'a.ts');

        // a's right edge is at 250, so b goes GAP past it
        assert.deepStrictEqual(state.homes.get('b.ts'), { x: 250 + GAP, y: 0 });
        assert.deepStrictEqual(state.homes.get('a.ts'), { x: 150, y: 0 });
    });

    test('pushes a box down when dropped on its top part', () => {
        const { info, state } = makeBoxes([['a.ts', { x: 200, y: -30 }], ['b.ts', { x: 200, y: 0 }]]);

        settleDrop(state, info, 'a.ts');

        // a's bottom edge is at 20
        assert.deepStrictEqual(state.homes.get('b.ts'), { x: 200, y: 20 + GAP });
    });

    test('pushes left at the top level, when there\'s room before the edge', () => {
        const { info, state } = makeBoxes([['a.ts', { x: 240, y: 20 }], ['b.ts', { x: 200, y: 0 }]]);

        settleDrop(state, info, 'a.ts');

        // a's center is right of b's, so b moves left until its right edge is GAP before a's left edge at 240
        assert.deepStrictEqual(state.homes.get('b.ts'), { x: 240 - GAP - 100, y: 0 });
    });

    test('a pushed box passes its push on the same way, so nothing ends up back under the dropped box', () => {
        // a tall box dropped over b and c pushes both down; b, now level with c and taller, must push c further down,
        // not back up under a
        const { info, state } = makeBoxes([['a.ts', { x: 0, y: 0 }], ['b.ts', { x: 0, y: 240 }], ['c.ts', { x: 0, y: 270 }]]);
        state.closedSizes.set('a.ts', { width: 100, height: 300 });
        state.closedSizes.set('b.ts', { width: 100, height: 80 });

        settleDrop(state, info, 'a.ts');

        assert.deepStrictEqual(state.homes.get('b.ts'), { x: 0, y: 300 + GAP });
        assert.deepStrictEqual(state.homes.get('c.ts'), { x: 0, y: 300 + GAP + 80 + GAP });
    });

    test('pushes right or down instead when away would pass a directory\'s left edge', () => {
        const { info, state } = makeBoxes([['d/a.ts', { x: 40, y: 0 }], ['d/b.ts', { x: 0, y: 0 }]]);

        settleDrop(state, info, 'd/a.ts');

        // left would put b below 0; right would be 180 away, down only 90, so it goes down
        assert.deepStrictEqual(state.homes.get('d/b.ts'), { x: 0, y: 50 + GAP });
    });

    test('grows a directory the user sized, when a child is dropped past its edge', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'src');
        resizeTo(state, info, 'src', boxSize(state, info, 'src'));
        const before = boxSize(state, info, 'src');

        moveTo(state, info, 'src/a.ts', { x: 2000, y: 0 });
        settleDrop(state, info, 'src/a.ts');

        assert.ok(boxSize(state, info, 'src').width > before.width);
    });

    test('keeps a squished directory squished when a child is dropped inside it', () => {
        // seven files in one column, squished from below until only 3 show
        const paths: string[] = [];
        for (let i = 1; i <= 7; i++) {
            paths.push('p/f' + i + '.ts');
        }
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: [] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'p');
        resizeTo(state, info, 'p', { width: boxSize(state, info, 'p').width, height: 0 });
        const before = boxSize(state, info, 'p');

        // pick up each shown file and drop it right where it's drawn, the way dragging does
        for (const [id, drawn] of arrangeShown(state, info, 'p').rects) {
            dropAt(state, info, id, drawn);
        }

        assert.deepStrictEqual(boxSize(state, info, 'p'), before);
    });

    test('lands a box exactly where it was dropped, even past a sibling that has grown', () => {
        // a has grown wide; nothing is shifted after the fact, so where b is dropped is where it's drawn
        const nodes = buildTree('repo', ['p/a/x.ts', 'p/b.ts']);
        const info = buildGraphInfo({ nodes: nodes, edges: [] });
        const state = createLayoutState();
        state.expanded.add('p');
        state.homes.set('p/a', { x: 0, y: 0 });
        state.homes.set('p/b.ts', { x: 0, y: 300 });
        state.closedSizes.set('p/a', { width: defaultSize(info, 'p/a').width + 500, height: defaultSize(info, 'p/a').height });

        const target = { x: 800, y: 300 };
        dropAt(state, info, 'p/b.ts', target);

        const drawn = arrangeChildren(state, info, 'p').get('p/b.ts')!;
        assert.deepStrictEqual({ x: drawn.x, y: drawn.y }, target);
    });

    test('moves nothing it didn\'t land on, even when the dropped box had grown', () => {
        // a has grown tall, so b, below it, is drawn shifted down
        const nodes = buildTree('repo', ['p/a/x.ts', 'p/b.ts']);
        const info = buildGraphInfo({ nodes: nodes, edges: [] });
        const state = createLayoutState();
        state.expanded.add('p');
        state.homes.set('p/a', { x: 0, y: 0 });
        state.homes.set('p/b.ts', { x: 0, y: 200 });
        state.closedSizes.set('p/a', { width: defaultSize(info, 'p/a').width, height: defaultSize(info, 'p/a').height + 300 });
        const bBefore = arrangeChildren(state, info, 'p').get('p/b.ts')!;

        // drag a far to the right, away from b
        dropAt(state, info, 'p/a', { x: 2000, y: 0 });

        assert.deepStrictEqual(arrangeChildren(state, info, 'p').get('p/b.ts'), bBefore);
    });

    test('pushes along a chain: what gets pushed pushes what it hits', () => {
        const { info, state } = makeBoxes([
            ['a.ts', { x: 150, y: 0 }],
            ['b.ts', { x: 200, y: 0 }],
            ['c.ts', { x: 340, y: 0 }],
        ]);

        settleDrop(state, info, 'a.ts');

        // b goes to 290, which runs into c, so c goes GAP past b's new right edge at 390
        assert.deepStrictEqual(state.homes.get('b.ts'), { x: 290, y: 0 });
        assert.deepStrictEqual(state.homes.get('c.ts'), { x: 390 + GAP, y: 0 });
    });

    test('while dragging, grows the directory and moves what\'s in its way, the same as a drop', () => {
        // d holds two files side by side, and c sits below d in its column
        const { info, state } = makeBoxes([['d/a.ts', { x: 0, y: 0 }], ['d/b.ts', { x: 150, y: 0 }], ['c.ts', { x: 0, y: 300 }]]);
        state.expanded.add('d');
        state.homes.set('d', { x: 0, y: 0 });
        const before = boxSize(state, info, 'd');

        dragTo(state, info, 'd/a.ts', { x: 0, y: 400 });

        const grown = boxSize(state, info, 'd').height - before.height;
        assert.ok(grown > 0);
        assert.deepStrictEqual(state.homes.get('c.ts'), { x: 0, y: 300 + grown });
    });

    test('while dragging, pushes nothing the box is over', () => {
        const { info, state } = makeBoxes([['a.ts', { x: 0, y: 0 }], ['b.ts', { x: 200, y: 0 }]]);

        dragTo(state, info, 'a.ts', { x: 180, y: 0 });

        assert.deepStrictEqual(state.homes.get('a.ts'), { x: 180, y: 0 });
        assert.deepStrictEqual(state.homes.get('b.ts'), { x: 200, y: 0 });
    });

    test('a copy of the state can change without changing the original', () => {
        const { info, state } = makeBoxes([['a.ts', { x: 0, y: 0 }]]);

        const copy = copyLayoutState(state);
        dragTo(copy, info, 'a.ts', { x: 500, y: 500 });

        assert.deepStrictEqual(state.homes.get('a.ts'), { x: 0, y: 0 });
    });
});
