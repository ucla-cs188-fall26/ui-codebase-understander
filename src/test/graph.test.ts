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
import { arrangeChildren, boxSize, buildGraphInfo, childOrigin, closeNode, createLayoutState, GraphInfo, moveTo, openNode, resetNode } from '../layout/state';
import { arrowZIndex, boxZIndexes, placeBoxes, visibleEdges } from '../layout/place';
import { fromSaved, toSaved } from '../layout/saved';
import { settleDrop } from '../layout/drop';
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
		closeNode(state, 'src');
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

		closeNode(state, ROOT_ID);

		assert.ok(state.expanded.has(ROOT_ID));
	});
});

suite('arrangeChildren', () => {
	// p holds a 2×2 block of 100×50 boxes: a top-left, b top-right, c bottom-left, d bottom-right.
	// a is a directory, so it can open.
	function makeBlock() {
		const nodes = buildTree('repo', ['p/a/x.ts', 'p/b.ts', 'p/c.ts', 'p/d.ts']);
		const info = buildGraphInfo({ nodes: nodes, edges: [] });
		const state = createLayoutState();
		const homes: [string, { x: number; y: number }][] = [
			['p/a', { x: 0, y: 0 }],
			['p/b.ts', { x: 200, y: 0 }],
			['p/c.ts', { x: 0, y: 100 }],
			['p/d.ts', { x: 200, y: 100 }],
		];
		for (const [id, home] of homes) {
			state.homes.set(id, home);
			state.closedSizes.set(id, { width: 100, height: 50 });
		}
		return { info: info, state: state };
	}

	test('leaves everything at home when nothing has grown', () => {
		const { info, state } = makeBlock();

		const arranged = arrangeChildren(state, info, 'p');

		assert.deepStrictEqual(arranged.get('p/a'), { x: 0, y: 0, width: 100, height: 50 });
		assert.deepStrictEqual(arranged.get('p/d.ts'), { x: 200, y: 100, width: 100, height: 50 });
	});

	test('shifts boxes past a grown box right, down, or both, keeping their places', () => {
		const { info, state } = makeBlock();

		// a opens 100 wider and 50 taller than its closed size
		state.expanded.add('p/a');
		state.openSizes.set('p/a', { width: 200, height: 100 });
		const arranged = arrangeChildren(state, info, 'p');

		assert.deepStrictEqual(arranged.get('p/b.ts'), { x: 300, y: 0, width: 100, height: 50 });
		assert.deepStrictEqual(arranged.get('p/c.ts'), { x: 0, y: 150, width: 100, height: 50 });
		assert.deepStrictEqual(arranged.get('p/d.ts'), { x: 300, y: 150, width: 100, height: 50 });
	});

	test('puts everything back home when the grown box closes', () => {
		const { info, state } = makeBlock();
		state.expanded.add('p/a');
		state.openSizes.set('p/a', { width: 200, height: 100 });

		closeNode(state, 'p/a');
		const arranged = arrangeChildren(state, info, 'p');

		assert.deepStrictEqual(arranged.get('p/b.ts'), { x: 200, y: 0, width: 100, height: 50 });
		assert.deepStrictEqual(arranged.get('p/c.ts'), { x: 0, y: 100, width: 100, height: 50 });
		assert.deepStrictEqual(arranged.get('p/d.ts'), { x: 200, y: 100, width: 100, height: 50 });
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
