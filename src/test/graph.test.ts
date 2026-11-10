import * as assert from 'assert';
import { buildEdges, buildTree } from '../graph/build';
import { scanImports } from '../graph/imports';
import { groupByParent, indexChildren, indexNodes } from '../analysis/lookups';
import { computeIndegrees, sortChildren } from '../analysis/metrics';
import { connections, findChildContaining, liftEdges } from '../analysis/edges';
import { assignColumns, findBackEdges } from '../layout/columns';
import { defaultLayout, GAP } from '../layout/defaultLayout';
import { arrowPath, chooseSides, placeArrows } from '../layout/arrows';
import { fitCamera, MAX_SCALE, zoomAt } from '../layout/camera';
import { boundsOf } from '../layout/geometry';
import { arrangeChildren, arrangeShown, boxSize, changeSize, buildGraphInfo, childOrigin, closeNode, createLayoutState, defaultSize, GraphInfo, LayoutState, moveTo, openNode, resetNode, resizeTo } from '../layout/state';
import { arrowZIndex, boxZIndexes, placeBoxes, placeStrips, stripId, visibleEdges } from '../layout/place';
import { fromSaved, toSaved } from '../layout/saved';
import { dropAt, settleDrop } from '../layout/drop';
import { minSquishHeight, minSquishWidth, squishHorizontally, squishVertically } from '../layout/squish';
import { nodeSize } from '../layout/size';
import { Edge, ROOT_ID } from '../graph/types';
import { CHILD_LIMIT, getVisibleNodes } from '../layout/visibility';
import { resolveImport } from '../graph/resolve';

suite('buildTree', () => {
	test('creates directories and counts direct children', () => {
		const paths = ['src/lib/b.ts', 'README.md', 'src/a.ts'];

		const nodes = buildTree('repo', paths);

		const summary = nodes.map((node) => [node.id, node.kind, node.parent, node.childCount]);
		assert.deepStrictEqual(summary, [
			['.', 'repo', null, 2],
			['README.md', 'file', '.', 0],
			['src', 'directory', '.', 2],
			['src/a.ts', 'file', 'src', 0],
			['src/lib', 'directory', 'src', 1],
			['src/lib/b.ts', 'file', 'src/lib', 0],
		]);
	});
});

suite('buildEdges', () => {
	test('keeps one edge per file pair and skips self-imports and packages', () => {
		const importsByFile = new Map<string, string[]>([
			['README.md', []],
			['src/app.ts', ['./lib/b', './lib/b.js', './app', 'react']],
			['src/lib/b.ts', ['../../README.md']],
		]);

		const edges = buildEdges(importsByFile);

		assert.deepStrictEqual(edges, [
			{ from: 'src/app.ts', to: 'src/lib/b.ts', kind: 'import' },
			{ from: 'src/lib/b.ts', to: 'README.md', kind: 'import' },
		]);
	});
});

suite('computeIndegrees', () => {
	test('counts imports entering each node from outside it', () => {
		const nodes = buildTree('repo', ['src/app.ts', 'src/lib/b.ts', 'src/lib/c.ts']);
		const edges: Edge[] = [
			{ from: 'src/app.ts', to: 'src/lib/b.ts', kind: 'import' },
			{ from: 'src/lib/c.ts', to: 'src/lib/b.ts', kind: 'import' },
		];

		const indegrees = computeIndegrees(indexNodes(nodes), edges);

		assert.strictEqual(indegrees.get('src/lib/b.ts'), 2);
		assert.strictEqual(indegrees.get('src/lib'), 1);
		assert.strictEqual(indegrees.get('src'), 0);
		assert.strictEqual(indegrees.get('.'), 0);
	});
});

suite('nodeSize', () => {
	test('gives the smallest box to a node with no children or imports', () => {
		assert.deepStrictEqual(nodeSize(0, 0), { width: 120, height: 36 });
	});

	test('grows with children and imports', () => {
		assert.deepStrictEqual(nodeSize(3, 7), { width: 190, height: 60 });
	});

	test('never grows past the maximum', () => {
		assert.deepStrictEqual(nodeSize(100000, 100000), { width: 260, height: 84 });
	});
});

suite('getVisibleNodes', () => {
	const nodes = buildTree('repo', ['README.md', 'src/app.ts', 'src/lib/b.ts', 'test/b.test.ts']);
	const childrenById = indexChildren(nodes);

	test('shows only the top level when nothing is expanded', () => {
		const visible = getVisibleNodes(childrenById, new Set(), new Map());

		assert.deepStrictEqual(visible.nodeIds, ['.', 'README.md', 'src', 'test']);
	});

	test('goes into expanded directories and stops at collapsed ones', () => {
		const visible = getVisibleNodes(childrenById, new Set(['src']), new Map());

		assert.deepStrictEqual(visible.nodeIds, ['.', 'README.md', 'src', 'src/app.ts', 'src/lib', 'test']);
	});

	suite('with more children than the limit', () => {
		const paths = Array.from({ length: 15 }, (_, index) => `src/file${index + 10}.ts`);
		const bigDirectoryChildren = indexChildren(buildTree('repo', paths));

		test('collapses the extra children into a box', () => {
			const visible = getVisibleNodes(bigDirectoryChildren, new Set(['src']), new Map());

			assert.strictEqual(visible.nodeIds.length, 2 + CHILD_LIMIT); // the root, src, and the shown files
			assert.deepStrictEqual(visible.moreBoxes, [
				{ id: 'src#more', parent: 'src', hiddenIds: paths.slice(CHILD_LIMIT) },
			]);
		});

		test('shows more children once revealed', () => {
			const visible = getVisibleNodes(bigDirectoryChildren, new Set(['src']), new Map([['src', 15]]));

			assert.strictEqual(visible.nodeIds.length, 2 + 15);
			assert.deepStrictEqual(visible.moreBoxes, []);
		});
	});
});

suite('sortChildren', () => {
	test('puts the highest indegree first and breaks ties alphabetically', () => {
		const nodes = buildTree('repo', ['a.ts', 'b.ts', 'z.ts']);
		const indegrees = new Map([['a.ts', 0], ['b.ts', 0], ['z.ts', 5]]);

		const sorted = sortChildren(['a.ts', 'b.ts', 'z.ts'], indexNodes(nodes), indegrees);

		assert.deepStrictEqual(sorted, ['z.ts', 'a.ts', 'b.ts']);
	});
});

suite('scanImports', () => {
	test('finds real imports and skips comments and strings', () => {
		const source = `
			import { a } from './a';
			// import { old } from './old';
			const b = require('./b');
			const text = "import { fake } from './fake'";
		`;

		const imports = scanImports(source);

		assert.deepStrictEqual(imports, ['./a', './b']);
	});
});

suite('resolveImport', () => {
	const files = new Set(['README.md', 'src/app.ts', 'src/lib/b.ts', 'src/utils/index.ts']);

	test('matches a full filename', () => {
		assert.strictEqual(resolveImport('../README.md', 'src/app.ts', files), 'README.md');
	});

	test('adds a missing extension', () => {
		assert.strictEqual(resolveImport('./lib/b', 'src/app.ts', files), 'src/lib/b.ts');
	});

	test('finds the index file of a directory', () => {
		assert.strictEqual(resolveImport('./utils', 'src/app.ts', files), 'src/utils/index.ts');
	});

	test('looks for the source file when a compiled file does not exist', () => {
		assert.strictEqual(resolveImport('./lib/b.js', 'src/app.ts', files), 'src/lib/b.ts');
	});

	test('prefers a real .js file over a .ts file with the same name', () => {
		const filesWithBoth = new Set(['src/b.js', 'src/b.ts']);
		assert.strictEqual(resolveImport('./b.js', 'src/app.ts', filesWithBoth), 'src/b.js');
	});

	test('skips packages', () => {
		assert.strictEqual(resolveImport('react', 'src/app.ts', files), undefined);
	});

	test('finds nothing for a missing file', () => {
		assert.strictEqual(resolveImport('./missing', 'src/app.ts', files), undefined);
	});
});

suite('findChildContaining', () => {
	test('finds the direct child that holds a node', () => {
		const nodes = buildTree('repo', ['src/a.ts', 'src/lib/c.ts', 'src/lib/x/b.ts', 'README.md']);
		const nodesById = indexNodes(nodes);

		assert.strictEqual(findChildContaining('src/lib/x/b.ts', 'src', nodesById), 'src/lib');
		assert.strictEqual(findChildContaining('src/lib/c.ts', 'src', nodesById), 'src/lib');
		assert.strictEqual(findChildContaining('src/a.ts', 'src', nodesById), 'src/a.ts');
		assert.strictEqual(findChildContaining('README.md', 'src', nodesById), undefined);
	});
});

suite('liftEdges', () => {
	test('keeps one edge per pair of children and skips edges inside one child or leaving the parent', () => {
		const nodes = buildTree('repo', ['src/a.ts', 'src/lib/c.ts', 'src/lib/x/b.ts', 'README.md']);
		const edges: Edge[] = [
			{ from: 'src/a.ts', to: 'src/lib/x/b.ts', kind: 'import' },
			{ from: 'src/a.ts', to: 'src/lib/c.ts', kind: 'import' },
			{ from: 'src/a.ts', to: 'README.md', kind: 'import' },
			{ from: 'src/lib/x/b.ts', to: 'src/lib/c.ts', kind: 'import' },
		];

		const lifted = liftEdges('src', edges, indexNodes(nodes));

		assert.deepStrictEqual(lifted, [
			{ from: 'src/a.ts', to: 'src/lib', kind: 'import' },
		]);
	});
});

suite('groupByParent', () => {
	test('groups nodes under their parents, both sorted', () => {
		const nodes = buildTree('repo', ['src/b.ts', 'src/a.ts', 'lib/c.ts', 'README.md']);

		const grouped = groupByParent(['src/b.ts', 'README.md', 'src/a.ts', 'lib/c.ts'], indexNodes(nodes));

		assert.deepStrictEqual(Array.from(grouped.entries()), [
			['.', ['README.md']],
			['lib', ['lib/c.ts']],
			['src', ['src/a.ts', 'src/b.ts']],
		]);
	});
});

suite('connections', () => {
	test('lists only edges crossing a node\'s boundary', () => {
		const nodes = buildTree('repo', ['src/a.ts', 'src/lib/b.ts', 'src/lib/c.ts', 'README.md']);
		const nodesById = indexNodes(nodes);
		const edges: Edge[] = [
			{ from: 'src/a.ts', to: 'src/lib/b.ts', kind: 'import' },
			{ from: 'src/lib/b.ts', to: 'src/lib/c.ts', kind: 'import' },
			{ from: 'src/lib/c.ts', to: 'README.md', kind: 'import' },
		];

		// b → c stays inside lib, so only the edges in from a.ts and out to README.md count
		assert.deepStrictEqual(connections('src/lib', edges, nodesById), {
			outgoing: ['README.md'],
			incoming: ['src/a.ts'],
		});
		assert.deepStrictEqual(connections('src/a.ts', edges, nodesById), {
			outgoing: ['src/lib/b.ts'],
			incoming: [],
		});
	});
});

// a short way to write an edge in the layout tests
function edge(from: string, to: string): Edge {
	return { from: from, to: to, kind: 'import' };
}

suite('findBackEdges', () => {
	test('finds nothing in a chain', () => {
		const edges = [edge('a', 'b'), edge('b', 'c')];

		const backEdges = findBackEdges(['a', 'b', 'c'], edges);

		assert.deepStrictEqual(Array.from(backEdges), []);
	});

	test('cuts the edge that returns to where the walk started', () => {
		const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];

		const backEdges = findBackEdges(['a', 'b', 'c'], edges);

		assert.deepStrictEqual(Array.from(backEdges), [edge('c', 'a')]);
	});

	test('finds nothing when two routes reach the same child', () => {
		const edges = [edge('a', 'b'), edge('a', 'c'), edge('c', 'b')];

		const backEdges = findBackEdges(['a', 'b', 'c'], edges);

		assert.deepStrictEqual(Array.from(backEdges), []);
	});
});

suite('assignColumns', () => {
	test('puts a child right of the furthest-right child pointing at it', () => {
		const edges = [edge('a', 'b'), edge('a', 'c'), edge('c', 'b')];

		const columns = assignColumns(['a', 'b', 'c'], edges);

		assert.deepStrictEqual(columns, new Map([['a', 0], ['c', 1], ['b', 2]]));
	});

	test('gives the same columns whatever order the children come in', () => {
		const edges = [edge('a', 'b'), edge('a', 'c'), edge('c', 'b')];

		const columns = assignColumns(['b', 'c', 'a'], edges);

		assert.deepStrictEqual(columns, new Map([['a', 0], ['c', 1], ['b', 2]]));
	});

	test('ignores the edge that closes a circle', () => {
		const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];

		const columns = assignColumns(['a', 'b', 'c'], edges);

		assert.deepStrictEqual(columns, new Map([['a', 0], ['b', 1], ['c', 2]]));
	});

	test('puts children with no edges in column 0', () => {
		const edges = [edge('a', 'b')];

		const columns = assignColumns(['a', 'b', 'z'], edges);

		assert.deepStrictEqual(columns, new Map([['a', 0], ['b', 1], ['z', 0]]));
	});
});

suite('defaultLayout', () => {
	const box = { width: 100, height: 50 };

	test('centers a short column against the tallest one', () => {
		const sizes = new Map([['a', box], ['b', box], ['c', box]]);

		const positions = defaultLayout(['a', 'b', 'c'], [edge('a', 'b'), edge('a', 'c')], sizes);

		// column 1 is 50 + GAP + 50 tall; column 0 is 50 tall, so it starts halfway down the difference
		assert.deepStrictEqual(positions, new Map([
			['a', { x: 0, y: GAP / 2 + 25 }],
			['b', { x: 100 + GAP, y: 0 }],
			['c', { x: 100 + GAP, y: 50 + GAP }],
		]));
	});

	test('starts the next column past the widest box', () => {
		const sizes = new Map([['a', { width: 200, height: 50 }], ['z', box], ['b', box]]);

		const positions = defaultLayout(['a', 'z', 'b'], [edge('a', 'b')], sizes);

		assert.deepStrictEqual(positions, new Map([
			['a', { x: 0, y: 0 }],
			['z', { x: 0, y: 50 + GAP }],
			['b', { x: 200 + GAP, y: GAP / 2 + 25 }],
		]));
	});

	test('stacks children with no edges in one column', () => {
		const sizes = new Map([['a', box], ['b', box], ['c', box]]);

		const positions = defaultLayout(['a', 'b', 'c'], [], sizes);

		assert.deepStrictEqual(positions, new Map([
			['a', { x: 0, y: 0 }],
			['b', { x: 0, y: 50 + GAP }],
			['c', { x: 0, y: 2 * (50 + GAP) }],
		]));
	});
});

suite('chooseSides', () => {
	const middle = { x: 200, y: 200, width: 100, height: 50 };

	test('uses facing left and right sides when the target is beside', () => {
		const right = { x: 400, y: 200, width: 100, height: 50 };
		const left = { x: 0, y: 200, width: 100, height: 50 };

		assert.deepStrictEqual(chooseSides(middle, right), { fromSide: 'right', toSide: 'left' });
		assert.deepStrictEqual(chooseSides(middle, left), { fromSide: 'left', toSide: 'right' });
	});

	test('uses facing top and bottom sides when the target is stacked', () => {
		const below = { x: 200, y: 400, width: 100, height: 50 };
		const above = { x: 200, y: 0, width: 100, height: 50 };

		assert.deepStrictEqual(chooseSides(middle, below), { fromSide: 'bottom', toSide: 'top' });
		assert.deepStrictEqual(chooseSides(middle, above), { fromSide: 'top', toSide: 'bottom' });
	});
});

suite('placeArrows', () => {
	test('attaches a lone arrow to the middle of each facing side', () => {
		const rects = new Map([
			['a', { x: 0, y: 0, width: 100, height: 50 }],
			['b', { x: 200, y: 0, width: 100, height: 50 }],
		]);

		const arrows = placeArrows([edge('a', 'b')], rects);

		assert.deepStrictEqual(arrows, [{
			from: 'a',
			to: 'b',
			start: { x: 100, y: 25 },
			startSide: 'right',
			end: { x: 200, y: 25 },
			endSide: 'left',
		}]);
	});

	test('spreads arrows sharing a side, the higher source getting the higher spot', () => {
		// the target is 60 tall, so its left side's thirds are at y = 100 + 20 and 100 + 40
		const rects = new Map([
			['high', { x: 0, y: 0, width: 100, height: 50 }],
			['low', { x: 0, y: 200, width: 100, height: 50 }],
			['target', { x: 300, y: 100, width: 100, height: 60 }],
		]);

		// low's edge comes first, so only the sort can put high's arrow on top
		const arrows = placeArrows([edge('low', 'target'), edge('high', 'target')], rects);

		assert.deepStrictEqual(arrows[0].end, { x: 300, y: 140 });
		assert.deepStrictEqual(arrows[1].end, { x: 300, y: 120 });
	});
});

suite('arrowPath', () => {
	test('pulls straight out of each side by half the distance', () => {
		const arrow = {
			from: 'a',
			to: 'b',
			start: { x: 100, y: 25 },
			startSide: 'right' as const,
			end: { x: 200, y: 25 },
			endSide: 'left' as const,
		};

		// 100 apart, so each pull point sits 50 out: both land at x = 150
		assert.strictEqual(arrowPath(arrow), 'M 100 25 C 150 25, 150 25, 200 25');
	});
});

suite('zoomAt', () => {
	test('keeps the world point under the mouse in place', () => {
		// before: the mouse at (110, 70) is over world point (100, 50)
		const camera = zoomAt({ x: 10, y: 20, scale: 1 }, { x: 110, y: 70 }, 2);

		assert.deepStrictEqual(camera, { x: -90, y: -30, scale: 2 });
		// after: (110 - -90) / 2 = 100 and (70 - -30) / 2 = 50, the same world point
	});

	test('stops at the largest scale', () => {
		const camera = zoomAt({ x: 0, y: 0, scale: 2.5 }, { x: 0, y: 0 }, 2);

		assert.strictEqual(camera.scale, MAX_SCALE);
	});
});

// a small graph for the view tests: root → src → { a.ts, lib → { b.ts, c.ts } }, with a.ts importing b.ts
function makeInfo(): GraphInfo {
	const nodes = buildTree('repo', ['src/a.ts', 'src/lib/b.ts', 'src/lib/c.ts']);
	return buildGraphInfo({ nodes: nodes, edges: [edge('src/a.ts', 'src/lib/b.ts')] });
}

suite('boundsOf', () => {
	test('finds the smallest rectangle around every box', () => {
		const rects = [{ x: 0, y: 0, width: 100, height: 50 }, { x: 200, y: 100, width: 50, height: 50 }];

		assert.deepStrictEqual(boundsOf(rects), { x: 0, y: 0, width: 250, height: 150 });
		assert.strictEqual(boundsOf([]), undefined);
	});
});

suite('fitCamera', () => {
	test('centers a small graph without enlarging it', () => {
		const camera = fitCamera({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 1000, height: 800 }, 40);

		// it would fit at 7.2×, but it stays at full size, its center at the viewport's center (500, 400)
		assert.deepStrictEqual(camera, { x: 450, y: 350, scale: 1 });
	});

	test('shrinks a big graph until it fits both ways', () => {
		const camera = fitCamera({ x: 0, y: 0, width: 2000, height: 1000 }, { x: 0, y: 0, width: 1000, height: 800 }, 0);

		// the width is the tighter fit: 1000 / 2000 = 0.5
		assert.deepStrictEqual(camera, { x: 0, y: 150, scale: 0.5 });
	});
});

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
	// p holds a 2×2 block at their default sizes, spaced far enough apart that none touch:
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
		assert.strictEqual(a.x, src.x + childOrigin().x + home.x);
		assert.strictEqual(a.y, src.y + childOrigin().y + home.y);
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
		assert.deepStrictEqual(visibleEdges(state, info, rects), [edge('src/a.ts', 'src/lib')]);
	});

	test('draws no arrow when both ends are in one closed box', () => {
		const info = makeInfo();
		const state = createLayoutState();
		openNode(state, info, ROOT_ID);
		const rects = placeBoxes(state, info, { x: 0, y: 0 });

		assert.deepStrictEqual(visibleEdges(state, info, rects), []);
	});
});

suite('settleDrop', () => {
	// 100×50 boxes with homes set by hand; paths decide whether they sit at the top level or in a directory
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

	test('pushes left at the top level, where there is no edge', () => {
		const { info, state } = makeBoxes([['a.ts', { x: 240, y: 20 }], ['b.ts', { x: 200, y: 0 }]]);

		settleDrop(state, info, 'a.ts');

		// a's center is right of b's, so b moves left until its right edge is GAP before a's left edge at 240
		assert.deepStrictEqual(state.homes.get('b.ts'), { x: 240 - GAP - 100, y: 0 });
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
});

suite('resizeTo', () => {
	test('stores open and closed sizes apart, and never goes below the minimum', () => {
		const info = makeInfo();
		const state = createLayoutState();

		resizeTo(state, info, 'src/a.ts', { width: 300, height: 90 });
		assert.deepStrictEqual(state.closedSizes.get('src/a.ts'), { width: 300, height: 90 });

		// an open box stops where its rows and columns are packed tight with at least 3 boxes each, plus its padding
		// and title; childOrigin's x is the padding
		openNode(state, info, 'src');
		resizeTo(state, info, 'src', { width: 10, height: 10 });
		const children = arrangeChildren(state, info, 'src');
		const origin = childOrigin();
		assert.deepStrictEqual(state.openSizes.get('src'), {
			width: origin.x + minSquishWidth(children) + origin.x,
			height: origin.y + minSquishHeight(children) + origin.x,
		});
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
		assert.strictEqual(shown.hiddenBottom.length, 2);
		assert.deepStrictEqual(shown.hiddenRight, []);
	});

	test('hides more when the user makes the directory smaller than its children need', () => {
		const { info, state } = makeSeven();
		const fits = boxSize(state, info, 'p');

		// the five shown files stack in one column, so shrinking from below hides the lowest ones, down to 3;
		// they join the two that were past the limit
		resizeTo(state, info, 'p', { width: fits.width, height: 0 });
		const shown = arrangeShown(state, info, 'p');

		assert.strictEqual(shown.rects.size, 3);
		assert.strictEqual(shown.hiddenBottom.length, 4);
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
});

suite('squishHorizontally', () => {
	// one row of 100×50 boxes, 40 apart: a at 0, b at 140, c at 280, d at 420; and e alone in a row below
	function makeRow() {
		return new Map([
			['a', { x: 0, y: 0, width: 100, height: 50 }],
			['b', { x: 140, y: 0, width: 100, height: 50 }],
			['c', { x: 280, y: 0, width: 100, height: 50 }],
			['d', { x: 420, y: 0, width: 100, height: 50 }],
			['e', { x: 0, y: 200, width: 100, height: 50 }],
		]);
	}

	function xOf(rects: Map<string, { x: number }>, id: string): number {
		return rects.get(id)!.x;
	}

	test('leaves everything in place when there is room', () => {
		const squished = squishHorizontally(makeRow(), 520);

		assert.deepStrictEqual(squished.rects, makeRow());
		assert.deepStrictEqual(squished.hidden, []);
	});

	test('shrinks every gap in a row evenly, keeping the order', () => {
		const squished = squishHorizontally(makeRow(), 480);

		// the three 40px gaps shrink together until d ends at the wall: 480 - 4 × 100 = 80 left, so 80 / 3 each
		const gapAB = xOf(squished.rects, 'b') - xOf(squished.rects, 'a') - 100;
		const gapBC = xOf(squished.rects, 'c') - xOf(squished.rects, 'b') - 100;
		const gapCD = xOf(squished.rects, 'd') - xOf(squished.rects, 'c') - 100;
		assert.ok(Math.abs(gapAB - 80 / 3) < 0.001);
		assert.ok(Math.abs(gapBC - gapAB) < 0.001);
		assert.ok(Math.abs(gapCD - gapAB) < 0.001);
		assert.ok(Math.abs(xOf(squished.rects, 'd') + 100 - 480) < 0.001);
	});

	test('hides the latest box in a row that is packed tight and still doesn\'t fit', () => {
		const squished = squishHorizontally(makeRow(), 400);

		// four boxes need at least 4 × 100 + 3 × 10 = 430, so d goes, and the other three fit back at home
		assert.deepStrictEqual(squished.hidden, ['d']);
		assert.strictEqual(xOf(squished.rects, 'c'), 280);
		assert.ok(!squished.rects.has('d'));
	});

	test('leaves other rows alone', () => {
		const squished = squishHorizontally(makeRow(), 400);

		assert.strictEqual(xOf(squished.rects, 'e'), 0);
		assert.ok(!squished.hidden.includes('e'));
	});

	test('never slides boxes onto each other in a staggered row', () => {
		// api overlaps db and config top to bottom, so all four count as one row; db and error sit above config
		const staggered = new Map([
			['api', { x: 0, y: 60, width: 300, height: 100 }],
			['db', { x: 330, y: 0, width: 300, height: 100 }],
			['config', { x: 600, y: 110, width: 260, height: 80 }],
			['error', { x: 640, y: 0, width: 260, height: 90 }],
		]);

		const squished = squishHorizontally(staggered, 860);

		for (const [idA, a] of squished.rects) {
			for (const [idB, b] of squished.rects) {
				if (idA < idB) {
					const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
					assert.ok(!overlap, idA + ' and ' + idB + ' overlap');
				}
			}
		}
	});

	test('counts stacked boxes as one column, so a staggered row keeps all three columns', () => {
		// api, then db above audit, then error above config: five boxes, three columns
		const staggered = new Map([
			['api', { x: 0, y: 60, width: 400, height: 100 }],
			['db', { x: 450, y: 0, width: 400, height: 100 }],
			['audit', { x: 450, y: 130, width: 310, height: 80 }],
			['error', { x: 900, y: 0, width: 300, height: 90 }],
			['config', { x: 900, y: 120, width: 280, height: 80 }],
		]);

		// as narrow as allowed: the three columns side by side, each as wide as its widest box
		const narrowest = minSquishWidth(staggered);
		assert.strictEqual(narrowest, 400 + 400 + 300 + 2 * 10);

		const squished = squishHorizontally(staggered, narrowest);
		assert.deepStrictEqual(squished.hidden, []);
		assert.strictEqual(squished.rects.size, 5);
	});

	test('keeps at least 3 boxes in a row', () => {
		// three boxes need 320; at 300 the row of four can lose d, but then it's down to 3 and can't lose more
		const squished = squishHorizontally(makeRow(), 300);

		assert.deepStrictEqual(squished.hidden, ['d']);
		assert.strictEqual(squished.fits, false);
	});

	test('finds the narrowest width where every row still fits with at least 3 boxes', () => {
		// the long row's first three: 3 × 100 + 2 × 10
		assert.strictEqual(minSquishWidth(makeRow()), 320);
		assert.strictEqual(squishHorizontally(makeRow(), 320).fits, true);
	});
});

suite('squishVertically', () => {
	// one column of 100×50 boxes, 40 apart: a at 0, b at 90, c at 180, d at 270
	function makeColumn() {
		return new Map([
			['a', { x: 0, y: 0, width: 100, height: 50 }],
			['b', { x: 0, y: 90, width: 100, height: 50 }],
			['c', { x: 0, y: 180, width: 100, height: 50 }],
			['d', { x: 0, y: 270, width: 100, height: 50 }],
		]);
	}

	test('shrinks gaps evenly from the bottom, then hides the lowest box', () => {
		// 310 - 4 × 50 = 110 left for the three gaps, so 110 / 3 each, and d ends at the bottom
		const squeezed = squishVertically(makeColumn(), 310);
		const gapAB = squeezed.rects.get('b')!.y - squeezed.rects.get('a')!.y - 50;
		const gapCD = squeezed.rects.get('d')!.y - squeezed.rects.get('c')!.y - 50;
		assert.ok(Math.abs(gapAB - 110 / 3) < 0.001);
		assert.ok(Math.abs(gapCD - gapAB) < 0.001);
		assert.ok(Math.abs(squeezed.rects.get('d')!.y + 50 - 310) < 0.001);

		// four need 4 × 50 + 3 × 10 = 230, so at 220 the lowest goes
		const jammed = squishVertically(makeColumn(), 220);
		assert.deepStrictEqual(jammed.hidden, ['d']);
	});

	test('finds the shortest height where every column still fits with at least 3 boxes', () => {
		assert.strictEqual(minSquishHeight(makeColumn()), 3 * 50 + 2 * 10);
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

	test('lets a box at the top level go anywhere, since the page has no edges', () => {
		const info = makeInfo();
		const state = createLayoutState();

		moveTo(state, info, 'src', { x: -50, y: -10 });

		assert.deepStrictEqual(state.homes.get('src'), { x: -50, y: -10 });
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

suite('saving the layout', () => {
	test('survives being saved and restored', () => {
		const info = makeInfo();
		const state = createLayoutState();
		openNode(state, info, ROOT_ID);
		openNode(state, info, 'src');
		state.homes.set('src/a.ts', { x: 500, y: 500 });
		state.closedSizes.set('src/lib', { width: 300, height: 90 });
		const camera = { x: 10, y: 20, scale: 1.5 };

		// through JSON text, the way a message or VS Code's storage carries it
		const text = JSON.stringify(toSaved(state, camera));
		const restored = fromSaved(JSON.parse(text), info);

		assert.deepStrictEqual(restored.state, state);
		assert.deepStrictEqual(restored.camera, camera);
	});

	test('drops anything about nodes that no longer exist', () => {
		const info = makeInfo();
		const saved = toSaved(createLayoutState(), { x: 0, y: 0, scale: 1 });
		saved.expanded.push('deleted');
		saved.homes.push(['deleted/file.ts', { x: 1, y: 1 }]);

		const restored = fromSaved(saved, info);

		assert.ok(!restored.state.expanded.has('deleted'));
		assert.ok(!restored.state.homes.has('deleted/file.ts'));
	});
});

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
		const padding = childOrigin().x;
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

		// the two past the limit, which would be below anyway, plus the two the squish hid
		assert.strictEqual(bottom.hiddenIds.length, 4);
		const box = rects.get('p')!;
		const padding = childOrigin().x;
		assert.strictEqual(bottom.rect.y + bottom.rect.height, box.y + box.height - padding);
		for (const child of childRects(rects)) {
			assert.ok(child.y + child.height <= bottom.rect.y - padding);
		}
	});

	test('shows every top-level node in the flow, and only 5 of the rest, with a strip below for them', () => {
		// a imports b; seven other files import nothing and nothing imports them
		const paths = ['a.ts', 'b.ts'];
		for (let i = 1; i <= 7; i++) {
			paths.push('u' + i + '.txt');
		}
		const info = buildGraphInfo({ nodes: buildTree('repo', paths), edges: [edge('a.ts', 'b.ts')] });
		const state = createLayoutState();
		openNode(state, info, ROOT_ID);
		const rects = placeBoxes(state, info, { x: 0, y: 0 });

		assert.ok(rects.has('a.ts') && rects.has('b.ts'));
		assert.strictEqual(rects.size, 2 + 5);

		const strips = placeStrips(state, info, rects);
		assert.strictEqual(strips.length, 1);
		assert.strictEqual(strips[0].ownerId, ROOT_ID);
		assert.strictEqual(strips[0].side, 'bottom');
		assert.strictEqual(strips[0].hiddenIds.length, 2);
		for (const rect of rects.values()) {
			assert.ok(strips[0].rect.y > rect.y + rect.height);
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

		assert.deepStrictEqual(edges, [edge(stripId('p', 'bottom'), 'p/f1.ts')]);
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

		assert.strictEqual(boxZ.get('src'), 2);
		assert.ok(boxZ.get('src/a.ts')! > 2);
		assert.ok(boxZ.get('src/lib')! > 2);
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

	test('paints an arrow below every box when no open box holds its ends', () => {
		const nodes = buildTree('repo', ['src/a.ts', 'top.ts']);
		const info = buildGraphInfo({ nodes: nodes, edges: [] });
		const state = createLayoutState();
		openNode(state, info, ROOT_ID);
		const boxZ = boxZIndexes(placeBoxes(state, info, { x: 0, y: 0 }));

		assert.strictEqual(arrowZIndex(edge('src', 'top.ts'), state, info, boxZ), 1);
	});
});
