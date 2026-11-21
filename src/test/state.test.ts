import * as assert from 'assert';
import { buildTree } from '../graph/build';
import { overlapsWithGap } from '../layout/geometry';
import { arrangeChildren, arrangeShown, boxSize, changeSize, buildGraphInfo, childOrigin, closeNode, createLayoutState, defaultSize, GraphInfo, LayoutState, HEADER, moveTo, openNode, PADDING, hiddenSides, resetNode, resizeTo, showNode, STRIP_THICKNESS } from '../layout/state';
import { placeBoxes, visibleEdges } from '../layout/place';
import { fromSaved, toSaved } from '../layout/saved';
import { dropAt } from '../layout/drop';
import { ROOT_ID } from '../graph/types';
import { edge, makeInfo } from './helpers';

suite('layout state', () => {
    test('opening a box gives its children homes', () => {
        const info = makeInfo();
        const state = createLayoutState();

        openNode(state, info, 'src');

        assert.ok(state.homes.has('src/a.ts'));
        assert.ok(state.homes.has('src/lib'));
    });

    test('reopening a box keeps homes the user changed', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, 'src');

        // what dragging will do
        state.homes.set('src/a.ts', { x: 500, y: 500 });
        closeNode(state, info, 'src');
        openNode(state, info, 'src');

        assert.deepStrictEqual(state.homes.get('src/a.ts'), { x: 500, y: 500 });
    });

    test('an open box fits its children, plus padding and room for its name', () => {
        const info = makeInfo();
        const state = createLayoutState();
        state.expanded.add('src');
        state.homes.set('src/a.ts', { x: 0, y: 0 });
        state.homes.set('src/lib', { x: 200, y: 0 });
        state.closedSizes.set('src/a.ts', { width: 100, height: 50 });
        state.closedSizes.set('src/lib', { width: 100, height: 80 });

        // children reach x = 300 and y = 80; padding is 20 per side and the name takes 32 at the top
        assert.deepStrictEqual(boxSize(state, info, 'src'), { width: 20 + 300 + 20, height: 32 + 20 + 80 + 20 });
    });

    test('opening a child grows its parent', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, 'src');
        const before = boxSize(state, info, 'src');

        openNode(state, info, 'src/lib');
        const after = boxSize(state, info, 'src');

        assert.ok(after.width > before.width || after.height > before.height);
    });

    test('sizes the user gave win over the defaults', () => {
        const info = makeInfo();
        const state = createLayoutState();
        state.closedSizes.set('src/a.ts', { width: 300, height: 300 });
        openNode(state, info, 'src');
        state.openSizes.set('src', { width: 999, height: 999 });

        assert.deepStrictEqual(boxSize(state, info, 'src/a.ts'), { width: 300, height: 300 });
        assert.deepStrictEqual(boxSize(state, info, 'src'), { width: 999, height: 999 });
    });

    test('the root stays open', () => {
        const state = createLayoutState();

        closeNode(state, makeInfo(), ROOT_ID);

        assert.ok(state.expanded.has(ROOT_ID));
    });
});

suite('making room when a box changes size', () => {
    // p holds a 2x2 block at their default sizes, spaced far enough apart that none touch:
    // a top-left, b top-right, c bottom-left, d bottom-right. a is a directory, so it can open.
    function makeBlock() {
        const nodes = buildTree('repo', ['p/a/x.ts', 'p/b.ts', 'p/c.ts', 'p/d.ts']);
        const info = buildGraphInfo({ nodes: nodes, edges: [] });
        const state = createLayoutState();
        state.homes.set('p/a', { x: 0, y: 0 });
        state.homes.set('p/b.ts', { x: 400, y: 0 });
        state.homes.set('p/c.ts', { x: 0, y: 200 });
        state.homes.set('p/d.ts', { x: 400, y: 200 });
        return { info: info, state: state };
    }

    // where a box ended up, without its size
    function positionOf(arranged: Map<string, { x: number; y: number }>, id: string) {
        const rect = arranged.get(id)!;
        return { x: rect.x, y: rect.y };
    }

    // a's size 100 wider and 50 taller than its default
    function grownSize(info: GraphInfo) {
        const original = defaultSize(info, 'p/a');
        return { width: original.width + 100, height: original.height + 50 };
    }

    test('leaves everything at home when nothing has grown', () => {
        const { info, state } = makeBlock();

        const arranged = arrangeChildren(state, info, 'p');

        assert.deepStrictEqual(positionOf(arranged, 'p/a'), { x: 0, y: 0 });
        assert.deepStrictEqual(positionOf(arranged, 'p/d.ts'), { x: 400, y: 200 });
    });

    // opens a at its grown size, the way opening and resizing go through changeSize
    function openGrown(state: LayoutState, info: GraphInfo) {
        function open() {
            state.expanded.add('p/a');
            state.openSizes.set('p/a', grownSize(info));
        }
        changeSize(state, info, 'p/a', open);
    }

    test('moves only what\'s in a growing box\'s path, by exactly the growth', () => {
        const { info, state } = makeBlock();

        openGrown(state, info);
        const arranged = arrangeChildren(state, info, 'p');

        // b is beside a and c is below it, so they move; d is off diagonally, out of a's way, so it stays
        assert.deepStrictEqual(positionOf(arranged, 'p/b.ts'), { x: 500, y: 0 });
        assert.deepStrictEqual(positionOf(arranged, 'p/c.ts'), { x: 0, y: 250 });
        assert.deepStrictEqual(positionOf(arranged, 'p/d.ts'), { x: 400, y: 200 });
    });

    test('moves what\'s in the path of a closed box the user resizes bigger', () => {
        const { info, state } = makeBlock();

        resizeTo(state, info, 'p/a', grownSize(info));
        const arranged = arrangeChildren(state, info, 'p');

        assert.deepStrictEqual(positionOf(arranged, 'p/b.ts'), { x: 500, y: 0 });
        assert.deepStrictEqual(positionOf(arranged, 'p/c.ts'), { x: 0, y: 250 });
    });

    test('leaves a box below but off to the side alone, and moves whatever a moved box would run into', () => {
        // a grows 300 taller; c is right below it; e is below c; f is lower down but far to the side
        const nodes = buildTree('repo', ['p/a/x.ts', 'p/c.ts', 'p/e.ts', 'p/f.ts']);
        const info = buildGraphInfo({ nodes: nodes, edges: [] });
        const state = createLayoutState();
        state.homes.set('p/a', { x: 0, y: 0 });
        state.homes.set('p/c.ts', { x: 0, y: 200 });
        state.homes.set('p/e.ts', { x: 0, y: 400 });
        state.homes.set('p/f.ts', { x: 800, y: 300 });

        const original = defaultSize(info, 'p/a');
        resizeTo(state, info, 'p/a', { width: original.width, height: original.height + 300 });
        const arranged = arrangeChildren(state, info, 'p');

        assert.deepStrictEqual(positionOf(arranged, 'p/c.ts'), { x: 0, y: 500 });
        assert.deepStrictEqual(positionOf(arranged, 'p/e.ts'), { x: 0, y: 700 });
        assert.deepStrictEqual(positionOf(arranged, 'p/f.ts'), { x: 800, y: 300 });
    });

    test('moves everything back when the grown box closes', () => {
        const { info, state } = makeBlock();
        openGrown(state, info);

        closeNode(state, info, 'p/a');
        const arranged = arrangeChildren(state, info, 'p');

        assert.deepStrictEqual(positionOf(arranged, 'p/b.ts'), { x: 400, y: 0 });
        assert.deepStrictEqual(positionOf(arranged, 'p/c.ts'), { x: 0, y: 200 });
        assert.deepStrictEqual(positionOf(arranged, 'p/d.ts'), { x: 400, y: 200 });
    });

    test('moves nothing when a box is dragged away, since there\'s no leftover shift', () => {
        const { info, state } = makeBlock();
        openGrown(state, info);
        const before = arrangeChildren(state, info, 'p');

        // drag the grown a far below everything
        dropAt(state, info, 'p/a', { x: 0, y: 2000 });

        const after = arrangeChildren(state, info, 'p');
        for (const id of ['p/b.ts', 'p/c.ts', 'p/d.ts']) {
            assert.deepStrictEqual(positionOf(after, id), positionOf(before, id));
        }
    });

    test('closing never pulls one box onto another', () => {
        const nodes = buildTree('repo', ['a/f1.ts', 'a/f2.ts', 'a/f3.ts', 'b.ts', 'c.ts']);
        const info = buildGraphInfo({ nodes: nodes, edges: [] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'a');

        // b beside the open a and c below it, close enough that pulling b left and c up would stack them
        dropAt(state, info, 'b.ts', { x: 180, y: 40 });
        dropAt(state, info, 'c.ts', { x: 40, y: 280 });
        closeNode(state, info, 'a');

        const rects = arrangeChildren(state, info, ROOT_ID);
        assert.ok(!overlapsWithGap(rects.get('b.ts')!, rects.get('c.ts')!, 0));
    });

    // every child of p's home, to compare before and after
    function homesIn(state: LayoutState, info: GraphInfo) {
        const homes = new Map<string, { x: number; y: number }>();
        for (const id of info.childrenById.get('p')!) {
            homes.set(id, state.homes.get(id)!);
        }
        return homes;
    }

    // a's size 500 wider and 300 taller than its default: big enough that d, off diagonally, is both beside and below it
    function hugeSize(info: GraphInfo) {
        const original = defaultSize(info, 'p/a');
        return { width: original.width + 500, height: original.height + 300 };
    }

    test('shrinking back takes back exactly what growing pushed, even a box pushed both right and down', () => {
        const { info, state } = makeBlock();
        const before = homesIn(state, info);

        resizeTo(state, info, 'p/a', hugeSize(info));
        assert.deepStrictEqual(state.homes.get('p/d.ts'), { x: 900, y: 500 });
        resizeTo(state, info, 'p/a', defaultSize(info, 'p/a'));

        assert.deepStrictEqual(homesIn(state, info), before);
    });

    test('growing two boxes and shrinking them back in the same order puts everything back', () => {
        const { info, state } = makeBlock();
        const before = homesIn(state, info);
        const cSize = defaultSize(info, 'p/c.ts');

        resizeTo(state, info, 'p/a', hugeSize(info));
        resizeTo(state, info, 'p/c.ts', { width: cSize.width + 300, height: cSize.height + 200 });
        resizeTo(state, info, 'p/a', defaultSize(info, 'p/a'));
        resizeTo(state, info, 'p/c.ts', cSize);

        assert.deepStrictEqual(homesIn(state, info), before);
    });

    test('a box the user moves after it was pushed stays where they put it when the pusher shrinks', () => {
        const { info, state } = makeBlock();
        resizeTo(state, info, 'p/a', grownSize(info));

        moveTo(state, info, 'p/b.ts', { x: 700, y: 600 });
        resizeTo(state, info, 'p/a', defaultSize(info, 'p/a'));

        assert.deepStrictEqual(state.homes.get('p/b.ts'), { x: 700, y: 600 });
        assert.deepStrictEqual(state.homes.get('p/c.ts'), { x: 0, y: 200 });
    });

    test('a box pushed both ways brings along one it would land on, and takes it back too', () => {
        const { info, state } = makeBlock();

        // e is in neither of a's paths, but d, pushed right and down, would land on it
        state.homes.set('p/e.ts', { x: 850, y: 520 });
        const nodes = buildTree('repo', ['p/a/x.ts', 'p/b.ts', 'p/c.ts', 'p/d.ts', 'p/e.ts']);
        const withE = buildGraphInfo({ nodes: nodes, edges: [] });
        const before = homesIn(state, withE);

        resizeTo(state, withE, 'p/a', hugeSize(withE));
        assert.deepStrictEqual(state.homes.get('p/e.ts'), { x: 1350, y: 820 });
        resizeTo(state, withE, 'p/a', defaultSize(withE, 'p/a'));

        assert.deepStrictEqual(homesIn(state, withE), before);
    });

    test('what a box pushed is still taken back after saving and loading', () => {
        const { info, state } = makeBlock();
        const before = homesIn(state, info);
        resizeTo(state, info, 'p/a', hugeSize(info));

        const text = JSON.stringify(toSaved(state, { x: 0, y: 0, scale: 1 }, 'default', 1));
        const restored = fromSaved(JSON.parse(text), info).state;
        resizeTo(restored, info, 'p/a', defaultSize(info, 'p/a'));

        assert.deepStrictEqual(homesIn(restored, info), before);
    });
});

suite('placing boxes', () => {
    test('places children inside their open parent, below its name', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'src');

        const rects = placeBoxes(state, info, { x: 0, y: 0 });

        const src = rects.get('src')!;
        const a = rects.get('src/a.ts')!;
        const home = state.homes.get('src/a.ts')!;
        assert.strictEqual(a.x, src.x + childOrigin(state, info, 'src').x + home.x);
        assert.strictEqual(a.y, src.y + childOrigin(state, info, 'src').y + home.y);
    });

    test('gives no box to children of a closed box', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);

        const rects = placeBoxes(state, info, { x: 0, y: 0 });

        assert.ok(rects.has('src'));
        assert.ok(!rects.has('src/a.ts'));
    });

    test('attaches arrows to the closed box holding each end', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'src');
        const rects = placeBoxes(state, info, { x: 0, y: 0 });

        // a.ts imports lib/b.ts, and lib is closed, so the arrow ends at lib
        assert.deepStrictEqual(visibleEdges(state, info, rects), [{ from: 'src/a.ts', to: 'src/lib', kind: 'import', count: 1, edges: [edge('src/a.ts', 'src/lib/b.ts')] }]);
    });

    test('counts the imports that land on one arrow', () => {
        // a.ts imports both files in lib, which is closed, so both land on one arrow to lib
        const nodes = buildTree('repo', ['src/a.ts', 'src/lib/b.ts', 'src/lib/c.ts']);
        const info = buildGraphInfo({ nodes: nodes, edges: [edge('src/a.ts', 'src/lib/b.ts'), edge('src/a.ts', 'src/lib/c.ts')] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'src');
        const rects = placeBoxes(state, info, { x: 0, y: 0 });

        assert.deepStrictEqual(visibleEdges(state, info, rects), [{ from: 'src/a.ts', to: 'src/lib', kind: 'import', count: 2, edges: [edge('src/a.ts', 'src/lib/b.ts'), edge('src/a.ts', 'src/lib/c.ts')] }]);
    });

    test('draws no arrow when both ends are in one closed box', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        const rects = placeBoxes(state, info, { x: 0, y: 0 });

        assert.deepStrictEqual(visibleEdges(state, info, rects), []);
    });
});

suite('resizeTo', () => {
    test('stores open and closed sizes apart, and never goes below the minimum', () => {
        const info = makeInfo();
        const state = createLayoutState();

        resizeTo(state, info, 'src/a.ts', { width: 300, height: 90 });
        assert.deepStrictEqual(state.closedSizes.get('src/a.ts'), { width: 300, height: 90 });

        // an open box stops at room for its biggest child and only the strips its pages need, plus its padding and
        // title: a imports lib, so they go on two pages side by side, each with one strip across and none down
        openNode(state, info, 'src');
        resizeTo(state, info, 'src', { width: 10, height: 10 });
        let widest = 0;
        let tallest = 0;
        for (const id of info.childrenById.get('src')!) {
            widest = Math.max(widest, boxSize(state, info, id).width);
            tallest = Math.max(tallest, boxSize(state, info, id).height);
        }
        const stripRoom = STRIP_THICKNESS + PADDING;
        assert.deepStrictEqual(state.openSizes.get('src'), {
            width: PADDING + widest + stripRoom + PADDING,
            height: HEADER + PADDING + tallest + PADDING,
        });
        assert.deepStrictEqual(hiddenSides(state, info, 'src').right, ['src/lib']);
        assert.ok(!state.closedSizes.has('src'));
    });
});

suite('arrangeShown', () => {
    // a directory with seven files: five get boxes, two start behind the right strip
    function makeSeven() {
        const paths: string[] = [];
        for (let i = 1; i <= 7; i++) {
            paths.push('p/f' + i + '.ts');
        }
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: [] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'p');
        return { info: info, state: state };
    }

    test('puts children past the limit where the layout would have put them: below, for one column', () => {
        // nothing imports anything, so all seven would stack in one column and the two extra would be at the bottom
        const { info, state } = makeSeven();

        const shown = arrangeShown(state, info, 'p');

        assert.strictEqual(shown.rects.size, 5);
        assert.strictEqual(shown.hidden.bottom.length, 2);
        assert.deepStrictEqual(shown.hidden.right, []);
    });

    test('hides more when the user makes the directory smaller than its children need', () => {
        const { info, state } = makeSeven();
        const fits = boxSize(state, info, 'p');

        // the five shown files stack in one column, so shrinking from below moves the lowest ones to later pages, down
        // to one; they join the two that were past the limit
        resizeTo(state, info, 'p', { width: fits.width, height: 0 });
        const shown = arrangeShown(state, info, 'p');

        assert.strictEqual(shown.rects.size, 1);
        assert.strictEqual(shown.hidden.bottom.length, 6);
    });
});

suite('jumping to a node', () => {
    // two top-level directories, each holding a directory with a file, plus a second directory in a
    function makeTwoBranches() {
        const nodes = buildTree('repo', ['a/x/f.ts', 'a/z/h.ts', 'b/y/g.ts']);
        const info = buildGraphInfo({ nodes: nodes, edges: [] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        return { info: info, state: state };
    }

    test('the next jump closes what the last one opened', () => {
        const { info, state } = makeTwoBranches();

        showNode(state, info, 'a/x/f.ts');
        showNode(state, info, 'b/y/g.ts');

        assert.ok(!state.expanded.has('a') && !state.expanded.has('a/x'));
        assert.ok(state.expanded.has('b') && state.expanded.has('b/y'));
    });

    test('keeps open what\'s on the way to the new node', () => {
        const { info, state } = makeTwoBranches();

        showNode(state, info, 'a/x/f.ts');
        showNode(state, info, 'a/z/h.ts');

        assert.ok(state.expanded.has('a') && state.expanded.has('a/z'));
        assert.ok(!state.expanded.has('a/x'));
    });

    test('never closes a directory the user opened', () => {
        const { info, state } = makeTwoBranches();
        openNode(state, info, 'a');

        showNode(state, info, 'a/x/f.ts');
        showNode(state, info, 'b/y/g.ts');

        assert.ok(state.expanded.has('a'));
        assert.ok(!state.expanded.has('a/x'));
    });

    test('keeps a jump-opened directory open while it holds one the user opened', () => {
        const { info, state } = makeTwoBranches();
        showNode(state, info, 'a/x/f.ts');

        // the user opens a/z by hand, inside a, which the jump opened
        openNode(state, info, 'a/z');
        showNode(state, info, 'b/y/g.ts');

        assert.ok(state.expanded.has('a') && state.expanded.has('a/z'));
        assert.ok(!state.expanded.has('a/x'));
    });

    test('closing puts the boxes around it back where they were', () => {
        const { info, state } = makeTwoBranches();
        const homesBefore = new Map(state.homes);

        showNode(state, info, 'a/x/f.ts');
        showNode(state, info, 'b/y/g.ts');
        showNode(state, info, 'a/x/f.ts');
        showNode(state, info, 'b/y/g.ts');

        // b was never pushed by a's growth for good: its home is back where it started, give or take rounding from
        // adding and taking away the same growth
        for (const id of ['a', 'b']) {
            assert.ok(Math.abs(state.homes.get(id)!.x - homesBefore.get(id)!.x) < 0.001);
            assert.ok(Math.abs(state.homes.get(id)!.y - homesBefore.get(id)!.y) < 0.001);
        }
    });
});

suite('moveTo', () => {
    test('moves a box, but never past its parent\'s left or top edge', () => {
        const info = makeInfo();
        const state = createLayoutState();

        moveTo(state, info, 'src/a.ts', { x: 300, y: 200 });
        assert.deepStrictEqual(state.homes.get('src/a.ts'), { x: 300, y: 200 });

        moveTo(state, info, 'src/a.ts', { x: -50, y: -10 });
        assert.deepStrictEqual(state.homes.get('src/a.ts'), { x: 0, y: 0 });
    });

    test('stops a top-level box at the root\'s left and top edge, like any directory\'s', () => {
        const info = makeInfo();
        const state = createLayoutState();

        moveTo(state, info, 'src', { x: -50, y: -10 });

        assert.deepStrictEqual(state.homes.get('src'), { x: 0, y: 0 });
    });
});

suite('resetNode', () => {
    // the root and src open, the way a fresh view would have them
    function openSrc() {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'src');
        return { info: info, state: state };
    }

    test('puts moved boxes back where the default layout had them', () => {
        const { info, state } = openSrc();
        const defaultHome = state.homes.get('src/a.ts');
        state.homes.set('src/a.ts', { x: 500, y: 500 });

        resetNode(state, info, 'src');

        assert.deepStrictEqual(state.homes.get('src/a.ts'), defaultHome);
    });

    test('forgets sizes the user gave the box and everything inside it', () => {
        const { info, state } = openSrc();
        state.openSizes.set('src', { width: 999, height: 999 });
        state.closedSizes.set('src/lib', { width: 300, height: 90 });

        resetNode(state, info, 'src');

        assert.ok(!state.openSizes.has('src'));
        assert.ok(!state.closedSizes.has('src/lib'));
    });

    test('closes the boxes inside it, but not itself', () => {
        const { info, state } = openSrc();
        openNode(state, info, 'src/lib');

        resetNode(state, info, 'src');

        assert.ok(state.expanded.has('src'));
        assert.ok(!state.expanded.has('src/lib'));
    });

    test('closes everything when the whole graph is reset', () => {
        const { info, state } = openSrc();
        openNode(state, info, 'src/lib');

        resetNode(state, info, ROOT_ID);

        assert.deepStrictEqual(Array.from(state.expanded), [ROOT_ID]);
    });

    test('leaves the box itself where it is', () => {
        const { info, state } = openSrc();
        state.homes.set('src', { x: 300, y: 300 });

        resetNode(state, info, 'src');

        assert.deepStrictEqual(state.homes.get('src'), { x: 300, y: 300 });
    });
});
