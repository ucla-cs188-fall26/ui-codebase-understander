import * as assert from 'assert';
import { assignColumns, findBackEdges } from '../layout/columns';
import { defaultLayout, GAP } from '../layout/defaultLayout';
import { nodeSize } from '../layout/size';
import { edge } from './helpers';

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
