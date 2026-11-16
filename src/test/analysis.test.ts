import * as assert from 'assert';
import { buildTree } from '../graph/build';
import { indexNodes } from '../analysis/lookups';
import { computeIndegrees, sortChildren } from '../analysis/metrics';
import { connections, findChildContaining, liftEdges } from '../analysis/edges';
import { buildGraphInfo } from '../layout/state';
import { groupInside, groupLinks } from '../layout/place';
import { Edge } from '../graph/types';

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

suite('sortChildren', () => {
	test('puts the highest indegree first and breaks ties alphabetically', () => {
		const nodes = buildTree('repo', ['a.ts', 'b.ts', 'z.ts']);
		const indegrees = new Map([['a.ts', 0], ['b.ts', 0], ['z.ts', 5]]);

		const sorted = sortChildren(['a.ts', 'b.ts', 'z.ts'], indexNodes(nodes), indegrees);

		assert.deepStrictEqual(sorted, ['z.ts', 'a.ts', 'b.ts']);
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
			outgoing: new Map([['README.md', 1]]),
			incoming: new Map([['src/a.ts', 1]]),
		});
		assert.deepStrictEqual(connections('src/a.ts', edges, nodesById), {
			outgoing: new Map([['src/lib/b.ts', 1]]),
			incoming: new Map(),
		});
	});
});

suite('groupLinks', () => {
	// app/error is imported by app/index.js, by two files deep in app/api, and by scripts/seed.js
	function makeImporters() {
		const nodes = buildTree('repo', ['app/error/index.js', 'app/index.js', 'app/api/v1/auth.js', 'app/api/v1/user.js', 'scripts/seed.js']);
		const info = buildGraphInfo({ nodes: nodes, edges: [] });
		const counts = new Map([['app/index.js', 1], ['app/api/v1/auth.js', 2], ['app/api/v1/user.js', 1], ['scripts/seed.js', 1]]);
		return { info: info, counts: counts };
	}

	test('groups like the arrows at depth 1, most imports first, and opens down to the files', () => {
		const { info, counts } = makeImporters();

		const groups = groupLinks('app/error', counts, info, 1);

		// inside app, one level below it; from outside app, the top-level folder
		const top: string[] = [];
		for (const group of groups) {
			top.push(group.id + ' ' + group.count);
		}
		assert.deepStrictEqual(top, ['app/api 3', 'app/index.js 1', 'scripts 1']);
		const v1 = groups[0].children[0];
		assert.strictEqual(v1.id, 'app/api/v1');
		assert.deepStrictEqual(v1.children.map(function idOf(group) {
			return group.id;
		}), ['app/api/v1/auth.js', 'app/api/v1/user.js']);
	});

	test('groups the files inside a box from one level inside it, counts adding up', () => {
		const { info } = makeImporters();
		const inside = new Map([['app/api/v1/auth.js', 2], ['app/api/v1/user.js', 1]]);

		const groups = groupInside('app/api', inside, info);

		assert.strictEqual(groups.length, 1);
		assert.strictEqual(groups[0].id, 'app/api/v1');
		assert.strictEqual(groups[0].count, 3);
		assert.strictEqual(groups[0].children.length, 2);
	});

	test('a file box is its own single row', () => {
		const { info } = makeImporters();

		const groups = groupInside('app/index.js', new Map([['app/index.js', 3]]), info);

		assert.deepStrictEqual(groups, [{ id: 'app/index.js', count: 3, children: [] }]);
	});

	test('lists the files themselves at the deepest depth', () => {
		const { info, counts } = makeImporters();

		const groups = groupLinks('app/error', counts, info, 10);

		assert.deepStrictEqual(groups.map(function idOf(group) {
			return group.id;
		}), ['app/api/v1/auth.js', 'app/api/v1/user.js', 'app/index.js', 'scripts/seed.js']);
		for (const group of groups) {
			assert.deepStrictEqual(group.children, []);
		}
	});
});
