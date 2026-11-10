import * as assert from 'assert';
import { buildEdges, buildTree } from '../graph/build';
import { scanImports } from '../graph/imports';
import { indexChildren, indexNodes } from '../analysis/lookups';
import { computeIndegrees, sortChildren } from '../analysis/metrics';
import { findChildContaining, liftEdges } from '../analysis/edges';
import { assignColumns, findBackEdges } from '../layout/columns';
import { defaultLayout, GAP } from '../layout/defaultLayout';
import { arrowPath, chooseSides, placeArrows } from '../layout/arrows';
import { nodeSize } from '../layout/size';
import { Edge } from '../graph/types';
import { CHILD_LIMIT, getVisibleNodes } from '../layout/visibility';
import { resolveImport } from '../graph/resolve';

suite('buildTree', () => {
	test('creates folders and counts direct children', () => {
		const paths = ['src/lib/b.ts', 'README.md', 'src/a.ts'];

		const nodes = buildTree('repo', paths);

		const summary = nodes.map((node) => [node.id, node.kind, node.parent, node.childCount]);
		assert.deepStrictEqual(summary, [
			['.', 'repo', null, 2],
			['README.md', 'file', '.', 0],
			['src', 'folder', '.', 2],
			['src/a.ts', 'file', 'src', 0],
			['src/lib', 'folder', 'src', 1],
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

	test('goes into expanded folders and stops at collapsed ones', () => {
		const visible = getVisibleNodes(childrenById, new Set(['src']), new Map());

		assert.deepStrictEqual(visible.nodeIds, ['.', 'README.md', 'src', 'src/app.ts', 'src/lib', 'test']);
	});

	suite('with more children than the limit', () => {
		const paths = Array.from({ length: 15 }, (_, index) => `src/file${index + 10}.ts`);
		const bigFolderChildren = indexChildren(buildTree('repo', paths));

		test('collapses the extra children into a box', () => {
			const visible = getVisibleNodes(bigFolderChildren, new Set(['src']), new Map());

			assert.strictEqual(visible.nodeIds.length, 2 + CHILD_LIMIT); // the root, src, and the shown files
			assert.deepStrictEqual(visible.moreBoxes, [
				{ id: 'src#more', parent: 'src', hiddenIds: paths.slice(CHILD_LIMIT) },
			]);
		});

		test('shows more children once revealed', () => {
			const visible = getVisibleNodes(bigFolderChildren, new Set(['src']), new Map([['src', 15]]));

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

	test('finds the index file of a folder', () => {
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
