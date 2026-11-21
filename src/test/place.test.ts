import * as assert from 'assert';
import { buildTree } from '../graph/build';
import { boxSize, buildGraphInfo, createLayoutState, openNode, PADDING, resizeTo } from '../layout/state';
import { arrowTouches, arrowZIndex, boxesUnderArrow, boxZIndexes, placeBoxes, placeStrips, stripId, visibleEdges } from '../layout/place';
import { Edge, ROOT_ID } from '../graph/types';
import { edge, makeInfo } from './helpers';

suite('placeStrips', () => {
    // seven files, either inside p or at the top level; five get boxes, and since nothing imports anything, the other two
    // would have stacked below them
    function makeSeven(directory: string) {
        const paths: string[] = [];
        for (let i = 1; i <= 7; i++) {
            paths.push(directory + 'f' + i + '.ts');
        }
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: [] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        if (directory !== '') {
            openNode(state, info, 'p');
        }
        return { info: info, state: state };
    }

    // the children p shows, as page rects
    function childRects(rects: Map<string, { x: number; y: number; width: number; height: number }>) {
        const children = [];
        for (const [id, rect] of rects) {
            if (id.startsWith('p/')) {
                children.push(rect);
            }
        }
        return children;
    }

    test('puts a right strip inside the box for children that would be right of the rest, with even padding', () => {
        // q imports f1 to f5, which makes them the five shown; f1 imports f6 and f7, which would put those in the next
        // column over, so they wait in the right strip
        const paths = ['q.ts'];
        const edges = [];
        for (let i = 1; i <= 7; i++) {
            paths.push('p/f' + i + '.ts');
            if (i <= 5) {
                edges.push(edge('q.ts', 'p/f' + i + '.ts'));
            }
        }
        edges.push(edge('p/f1.ts', 'p/f6.ts'), edge('p/f1.ts', 'p/f7.ts'));
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: edges });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'p');
        const rects = placeBoxes(state, info, { x: 0, y: 0 });

        const strips = placeStrips(state, info, rects).filter(function isP(strip) {
            return strip.ownerId === 'p';
        });

        assert.strictEqual(strips.length, 1);
        assert.strictEqual(strips[0].side, 'right');
        assert.strictEqual(strips[0].hiddenIds.length, 2);

        // one padding in from the box's right edge, and every child at least one padding before the strip
        const box = rects.get('p')!;
        const padding = PADDING;
        assert.strictEqual(strips[0].rect.x + strips[0].rect.width, box.x + box.width - padding);
        for (const child of childRects(rects)) {
            assert.ok(child.x + child.width <= strips[0].rect.x - padding);
        }
    });

    test('puts a bottom strip inside the box when squished from below, with even padding', () => {
        const { info, state } = makeSeven('p/');
        resizeTo(state, info, 'p', { width: boxSize(state, info, 'p').width, height: 0 });
        const rects = placeBoxes(state, info, { x: 0, y: 0 });

        const bottom = placeStrips(state, info, rects).find(function isBottom(strip) {
            return strip.side === 'bottom';
        })!;

        // the two past the limit, which would be below anyway, plus the four that no longer fit
        assert.strictEqual(bottom.hiddenIds.length, 6);
        const box = rects.get('p')!;
        const padding = PADDING;
        assert.strictEqual(bottom.rect.y + bottom.rect.height, box.y + box.height - padding);
        for (const child of childRects(rects)) {
            assert.ok(child.y + child.height <= bottom.rect.y - padding);
        }
    });

    test('the root\'s first page shows the flow, and at most 5 boxes down a column, the others behind its strip', () => {
        // a imports b; seven other files import nothing and nothing imports them, and stack below a
        const paths = ['a.ts', 'b.ts'];
        for (let i = 1; i <= 7; i++) {
            paths.push('u' + i + '.txt');
        }
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: [edge('a.ts', 'b.ts')] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        const rects = placeBoxes(state, info, { x: 0, y: 0 });

        // the root's own box, the two in the flow, and four others: a's column holds a and the four below it
        assert.ok(rects.has(ROOT_ID) && rects.has('a.ts') && rects.has('b.ts'));
        assert.strictEqual(rects.size, 1 + 2 + 4);

        // the other three wait inside the root, below its boxes
        const strips = placeStrips(state, info, rects);
        assert.strictEqual(strips.length, 1);
        assert.strictEqual(strips[0].ownerId, ROOT_ID);
        assert.strictEqual(strips[0].side, 'bottom');
        assert.strictEqual(strips[0].hiddenIds.length, 3);
        const root = rects.get(ROOT_ID)!;
        for (const [id, rect] of rects) {
            if (id !== ROOT_ID) {
                assert.ok(strips[0].rect.y > rect.y + rect.height);
            }
        }
        assert.ok(strips[0].rect.y + strips[0].rect.height < root.y + root.height);
    });

    test('lays out the root\'s nodes in the flow first, and the rest below them', () => {
        const paths = ['a.ts', 'b.ts', 'readme.md'];
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: [edge('a.ts', 'b.ts')] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);

        const readme = state.homes.get('readme.md')!;
        for (const id of ['a.ts', 'b.ts']) {
            const home = state.homes.get(id)!;
            assert.ok(readme.y >= home.y + boxSize(state, info, id).height);
        }
    });

    test('ends an arrow to a hidden file at the strip hiding it, painted above the strip\'s box', () => {
        // f7 imports f1, which makes f1 the most important; the rest sort by name, so f6 and f7 stay hidden
        const paths: string[] = [];
        for (let i = 1; i <= 7; i++) {
            paths.push('p/f' + i + '.ts');
        }
        const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: [edge('p/f7.ts', 'p/f1.ts')] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'p');
        const rects = placeBoxes(state, info, { x: 0, y: 0 });

        const edges = visibleEdges(state, info, rects, placeStrips(state, info, rects));

        assert.deepStrictEqual(edges, [{ from: stripId('p', 'bottom'), to: 'p/f1.ts', kind: 'import', count: 1, edges: [edge('p/f7.ts', 'p/f1.ts')] }]);
        const boxZ = boxZIndexes(rects);
        assert.strictEqual(arrowZIndex(edges[0], state, info, boxZ), boxZ.get('p')! + 1);
    });

    test('makes no strips when nothing is hidden', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'src');

        assert.deepStrictEqual(placeStrips(state, info, placeBoxes(state, info, { x: 0, y: 0 })), []);
    });
});

suite('paint order', () => {
    test('numbers boxes so children paint above their parent', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'src');

        const boxZ = boxZIndexes(placeBoxes(state, info, { x: 0, y: 0 }));

        // the root first, around everything, then src, then what's in src
        assert.strictEqual(boxZ.get(ROOT_ID), 2);
        assert.ok(boxZ.get('src')! > boxZ.get(ROOT_ID)!);
        assert.ok(boxZ.get('src/a.ts')! > boxZ.get('src')!);
        assert.ok(boxZ.get('src/lib')! > boxZ.get('src')!);
    });

    test('paints an arrow just above the open box holding its ends', () => {
        const info = makeInfo();
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'src');
        const boxZ = boxZIndexes(placeBoxes(state, info, { x: 0, y: 0 }));

        const z = arrowZIndex(edge('src/a.ts', 'src/lib'), state, info, boxZ);

        assert.strictEqual(z, boxZ.get('src')! + 1);
    });

    test('paints an arrow between top-level boxes just above the root, below every other box', () => {
        const nodes = buildTree('repo', ['src/a.ts', 'top.ts']);
        const info = buildGraphInfo({ nodes: nodes, edges: [] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        const boxZ = boxZIndexes(placeBoxes(state, info, { x: 0, y: 0 }));

        assert.strictEqual(arrowZIndex(edge('src', 'top.ts'), state, info, boxZ), boxZ.get(ROOT_ID)! + 1);
    });

    // top.ts and two open directories: app holds db.ts and a closed api, and other holds y.ts
    function makeTwoOpen() {
        const nodes = buildTree('repo', ['top.ts', 'app/db.ts', 'app/api/x.ts', 'other/y.ts']);
        const info = buildGraphInfo({ nodes: nodes, edges: [edge('top.ts', 'app/db.ts')] });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        openNode(state, info, 'app');
        openNode(state, info, 'other');
        const rects = placeBoxes(state, info, { x: 0, y: 0 });
        return { info: info, rects: rects };
    }

    test('an arrow passes under every box but its ends and the open boxes holding them, outermost only', () => {
        const { info, rects } = makeTwoOpen();

        const under = boxesUnderArrow(edge('top.ts', 'app/db.ts'), info, rects);

        // app's other child and the other top-level directory; y.ts is covered by other, so it isn't listed
        assert.deepStrictEqual(under.toSorted(), ['app/api', 'other']);
    });

    test('an arrow to a strip counts the strip\'s box as holding it', () => {
        const { info, rects } = makeTwoOpen();

        const under = boxesUnderArrow(edge('top.ts', stripId('app', 'bottom')), info, rects);

        assert.ok(!under.includes('app'));
        assert.ok(under.includes('app/db.ts'));
    });

    test('leaves out boxes that don\'t overlap the arrow\'s area', () => {
        const { info, rects } = makeTwoOpen();
        const api = rects.get('app/api')!;

        const under = boxesUnderArrow(edge('top.ts', 'app/db.ts'), info, rects, api);

        assert.deepStrictEqual(under, ['app/api']);
    });

    // an arrow as visibleEdges makes it, drawn between two ends and carrying the given edges
    function carrying(from: string, to: string, edges: Edge[]) {
        return { from: from, to: to, kind: 'import' as const, count: edges.length, edges: edges };
    }

    test('an arrow from a file inside a box belongs to the box', () => {
        const { info } = makeTwoOpen();
        const arrow = carrying('top.ts', 'app/db.ts', [edge('top.ts', 'app/db.ts')]);

        assert.ok(arrowTouches(arrow, 'app', info));
        assert.ok(arrowTouches(arrow, 'top.ts', info));
    });

    test('an arrow to a strip belongs to the strip\'s box', () => {
        const { info } = makeTwoOpen();

        assert.ok(arrowTouches(carrying('top.ts', stripId('app', 'bottom'), [edge('top.ts', 'app/api/x.ts')]), 'app', info));
    });

    test('an arrow between two other boxes doesn\'t belong to a box', () => {
        const { info } = makeTwoOpen();
        const arrow = carrying('top.ts', 'app/db.ts', [edge('top.ts', 'app/db.ts')]);

        assert.ok(!arrowTouches(arrow, 'other', info));
        assert.ok(!arrowTouches(arrow, 'app/api', info));
    });
});

suite('arrow depth', () => {
    // app holds api (login, session), db (users), and config.ts; scripts holds seed. Everything is open
    function makeApp() {
        const nodes = buildTree('repo', ['app/api/login.ts', 'app/api/session.ts', 'app/db/users.ts', 'app/config.ts', 'scripts/seed.ts']);
        const edges = [
            edge('app/api/login.ts', 'app/db/users.ts'),
            edge('app/api/login.ts', 'app/api/session.ts'),
            edge('app/api/login.ts', 'scripts/seed.ts'),
            edge('app/api/session.ts', 'app/db/users.ts'),
            edge('app/api/session.ts', 'app/config.ts'),
        ];
        const info = buildGraphInfo({ nodes: nodes, edges: edges });
        const state = createLayoutState();
        for (const id of [ROOT_ID, 'app', 'app/api', 'app/db', 'scripts']) {
            openNode(state, info, id);
        }
        const rects = placeBoxes(state, info, { x: 0, y: 0 });
        return { info: info, state: state, rects: rects };
    }

    // each arrow as "from > to xCount", easy to read in a failure
    function describe(edges: { from: string; to: string; count: number }[]): string[] {
        const described: string[] = [];
        for (const visible of edges) {
            described.push(visible.from + ' > ' + visible.to + ' x' + visible.count);
        }
        return described;
    }

    test('a kept file gets its own arrow while its sibling\'s import stays merged into their folder', () => {
        const { info, state, rects } = makeApp();

        const edges = visibleEdges(state, info, rects, [], 1, ['app/api/login.ts']);

        const described = describe(edges);
        assert.ok(described.includes('app/api/login.ts > app/db x1'));
        assert.ok(described.includes('app/api > app/db x1'));
    });

    test('a kept file\'s arrows still group their other end at the depth', () => {
        const { info, state, rects } = makeApp();

        const edges = visibleEdges(state, info, rects, [], 1, ['app/api/login.ts']);

        // seed.ts sits in scripts, one level below the root the arrow lives in
        assert.ok(describe(edges).includes('app/api/login.ts > scripts x1'));
    });

    test('a pinned arrow keeps its ends without splitting out any other arrow', () => {
        const { info, state, rects } = makeApp();

        // login.ts was selected, so its arrow to db was split out; then that arrow was clicked, deselecting login.ts
        const withLogin = visibleEdges(state, info, rects, [], 1, ['app/api/login.ts']);
        const clicked = withLogin.find((visible) => visible.from === 'app/api/login.ts' && visible.to === 'app/db')!;
        const edges = visibleEdges(state, info, rects, [], 1, [], clicked);

        const described = describe(edges);
        assert.ok(described.includes('app/api/login.ts > app/db x1'));
        assert.ok(described.includes('app/api > app/db x1'));
        // login.ts's other arrows merge back into api
        assert.ok(!described.includes('app/api/login.ts > scripts x1'));
    });

    test('keeping a box no deeper than the depth changes nothing', () => {
        const { info, state, rects } = makeApp();

        const kept = visibleEdges(state, info, rects, [], 1, ['app']);
        const plain = visibleEdges(state, info, rects, [], 1);

        assert.deepStrictEqual(describe(kept), describe(plain));
    });

    test('at depth 1, each arrow joins the outermost boxes that differ, and arrows on the same two boxes merge', () => {
        const { info, state, rects } = makeApp();

        const edges = visibleEdges(state, info, rects, [], 1);

        assert.deepStrictEqual(describe(edges), [
            'app/api > app/db x2',
            'app/api/login.ts > app/api/session.ts x1',
            'app > scripts x1',
            'app/api > app/config.ts x1',
        ]);
    });

    test('at depth 2, ends go one level further below the folder the arrow lives in', () => {
        const { info, state, rects } = makeApp();

        const edges = visibleEdges(state, info, rects, [], 2);

        assert.deepStrictEqual(describe(edges), [
            'app/api/login.ts > app/db/users.ts x1',
            'app/api/login.ts > app/api/session.ts x1',
            'app/api > scripts/seed.ts x1',
            'app/api/session.ts > app/db/users.ts x1',
            'app/api/session.ts > app/config.ts x1',
        ]);
    });

    test('with no limit, every end attaches to the deepest visible box', () => {
        const { info, state, rects } = makeApp();

        const edges = visibleEdges(state, info, rects, []);

        assert.deepStrictEqual(describe(edges), [
            'app/api/login.ts > app/db/users.ts x1',
            'app/api/login.ts > app/api/session.ts x1',
            'app/api/login.ts > scripts/seed.ts x1',
            'app/api/session.ts > app/db/users.ts x1',
            'app/api/session.ts > app/config.ts x1',
        ]);
    });

    test('a file\'s grouped arrows still belong to it, but its neighbors\' don\'t', () => {
        const { info, state, rects } = makeApp();

        const edges = visibleEdges(state, info, rects, [], 1);
        const lit: string[] = [];
        for (const visible of edges) {
            if (arrowTouches(visible, 'app/api/login.ts', info)) {
                lit.push(visible.from + ' > ' + visible.to);
            }
        }

        // api > config only carries session's import
        assert.deepStrictEqual(lit, ['app/api > app/db', 'app/api/login.ts > app/api/session.ts', 'app > scripts']);
    });
});

suite('kinds of arrows', () => {
    // a.ts imports b.ts, and also sends c.ts an event and b.ts a message; everything is at the top level
    function makeKinds() {
        const nodes = buildTree('repo', ['a.ts', 'b.ts', 'c.ts']);
        const edges: Edge[] = [
            edge('a.ts', 'b.ts'),
            { from: 'a.ts', to: 'c.ts', kind: 'event', lines: { start: 2, end: 2 }, name: 'saved' },
            { from: 'a.ts', to: 'b.ts', kind: 'message', lines: { start: 3, end: 3 }, name: 'open' },
        ];
        const info = buildGraphInfo({ nodes: nodes, edges: edges });
        const state = createLayoutState();
        openNode(state, info, ROOT_ID);
        const rects = placeBoxes(state, info, { x: 0, y: 0 });
        return { info: info, state: state, rects: rects };
    }

    // each arrow as "from > to kind", easy to read in a failure
    function describe(edges: { from: string; to: string; kind: string }[]): string[] {
        return edges.map((visible) => visible.from + ' > ' + visible.to + ' ' + visible.kind);
    }

    test('an import and a message between the same two boxes are two arrows', () => {
        const { info, state, rects } = makeKinds();

        const edges = visibleEdges(state, info, rects);

        assert.deepStrictEqual(describe(edges), ['a.ts > b.ts import', 'a.ts > c.ts event', 'a.ts > b.ts message']);
    });

    test('draws only the kinds the arrow settings show', () => {
        const { info, state, rects } = makeKinds();

        const edges = visibleEdges(state, info, rects, [], Infinity, [], undefined, new Set(['event', 'message']));

        assert.deepStrictEqual(describe(edges), ['a.ts > c.ts event', 'a.ts > b.ts message']);
    });

    test('events and messages don\'t count toward how important a box is', () => {
        const { info } = makeKinds();

        assert.strictEqual(info.indegrees.get('b.ts'), 1);
        assert.strictEqual(info.indegrees.get('c.ts'), 0);
        assert.deepStrictEqual(info.importEdges, [edge('a.ts', 'b.ts')]);
    });

    test('knows which kinds the graph has', () => {
        const withAll = makeKinds().info;
        const importsOnly = buildGraphInfo({ nodes: buildTree('repo', ['a.ts', 'b.ts']), edges: [edge('a.ts', 'b.ts')] });

        assert.deepStrictEqual(withAll.kindsPresent, new Set(['import', 'event', 'message']));
        assert.deepStrictEqual(importsOnly.kindsPresent, new Set(['import']));
    });
});
