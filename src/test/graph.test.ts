import * as assert from 'assert';
import { buildEdges, buildTree } from '../graph/build';
import { scanImports } from '../graph/imports';
import { indexChildren, indexNodes } from '../analysis/lookups';
import { computeIndegrees, sortChildrenOfFolder } from '../analysis/metrics';
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

suite('sortChildrenOfFolder', () => {
	test('puts the highest indegree first and breaks ties alphabetically', () => {
		const nodes = buildTree('repo', ['a.ts', 'b.ts', 'z.ts']);
		const indegrees = new Map([['a.ts', 0], ['b.ts', 0], ['z.ts', 5]]);

		const sorted = sortChildrenOfFolder(['a.ts', 'b.ts', 'z.ts'], indexNodes(nodes), indegrees);

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
