import * as assert from 'assert';
import { arrowHead, arrowPath, arrowPulls, arrowWidth, chooseSides, placeArrows } from '../layout/arrows';
import { Edge } from '../graph/types';
import { edge } from './helpers';

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

    test('connects a box to a long thin strip below it by their facing sides, not the strip\'s far end', () => {
        // the strip's center is far to the right, but it runs right under the box
        const strip = { x: 0, y: 400, width: 2000, height: 16 };

        assert.deepStrictEqual(chooseSides(middle, strip), { fromSide: 'bottom', toSide: 'top' });
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

    test('puts an end on the side nearest its other box, the higher source getting the higher spot', () => {
        // the target's left side runs from y = 100 to 160; each end goes to the end of it nearest its source, 10 in
        const rects = new Map([
            ['high', { x: 0, y: 0, width: 100, height: 50 }],
            ['low', { x: 0, y: 200, width: 100, height: 50 }],
            ['target', { x: 300, y: 100, width: 100, height: 60 }],
        ]);

        // low's edge comes first, so only the sort can put high's arrow on top
        const arrows = placeArrows([edge('low', 'target'), edge('high', 'target')], rects);

        assert.deepStrictEqual(arrows[0].end, { x: 300, y: 150 });
        assert.deepStrictEqual(arrows[1].end, { x: 300, y: 110 });
    });

    test('runs an arrow straight across between boxes that overlap', () => {
        // a covers y 0 to 50 and b 30 to 130; away from their corners, they can both take an end at y = 40
        const rects = new Map([
            ['a', { x: 0, y: 0, width: 100, height: 50 }],
            ['b', { x: 200, y: 30, width: 100, height: 100 }],
        ]);

        const arrows = placeArrows([edge('a', 'b')], rects);

        assert.strictEqual(arrows[0].start.y, arrows[0].end.y);
    });

    test('nudges ends that want the same spot apart, keeping their order and leaving room for each', () => {
        // five sources stacked to the left, all overlapping the tall target, so every end would like its middle
        const rects = new Map<string, { x: number; y: number; width: number; height: number }>([
            ['target', { x: 300, y: 0, width: 100, height: 300 }],
        ]);
        const edges: Edge[] = [];
        for (let i = 0; i < 5; i++) {
            rects.set('s' + i, { x: 0, y: 140 + i, width: 100, height: 20 });
            edges.push(edge('s' + i, 'target'));
        }

        const arrows = placeArrows(edges, rects);

        // each head is 9 wide at the default width, with 4 between them
        const spots = arrows.map(function endY(arrow) {
            return arrow.end.y;
        });
        for (let i = 1; i < spots.length; i++) {
            assert.ok(spots[i] - spots[i - 1] >= 9 + 4 - 0.001);
        }
    });

    test('arrows leaving one side of a box share a start point, and their heads stay apart', () => {
        // one source on the left, three targets to its right at different heights
        const rects = new Map([
            ['source', { x: 0, y: 100, width: 100, height: 60 }],
            ['high', { x: 300, y: 0, width: 100, height: 40 }],
            ['middle', { x: 300, y: 110, width: 100, height: 40 }],
            ['low', { x: 300, y: 220, width: 100, height: 40 }],
        ]);

        const arrows = placeArrows([edge('source', 'high'), edge('source', 'middle'), edge('source', 'low')], rects);

        for (const arrow of arrows) {
            assert.strictEqual(arrow.startSide, 'right');
            assert.deepStrictEqual(arrow.start, arrows[0].start);
        }
        assert.notDeepStrictEqual(arrows[0].end, arrows[1].end);
        assert.notDeepStrictEqual(arrows[1].end, arrows[2].end);
    });

    test('a shared start and a head coming into the same side sit apart', () => {
        // a sends two arrows right and gets one back from b, all on its right side
        const rects = new Map([
            ['a', { x: 0, y: 0, width: 100, height: 100 }],
            ['b', { x: 300, y: 0, width: 100, height: 100 }],
            ['c', { x: 300, y: 30, width: 100, height: 40 }],
        ]);

        const arrows = placeArrows([edge('a', 'b'), edge('a', 'c'), edge('b', 'a')], rects);

        assert.deepStrictEqual(arrows[0].start, arrows[1].start);
        assert.strictEqual(arrows[2].endSide, 'right');
        assert.ok(Math.abs(arrows[2].end.y - arrows[0].start.y) >= 9 / 2 + 1.5 / 2 + 4 - 0.001);
    });

    test('spills a crowded side\'s outermost ends onto the sides next to it', () => {
        // a short target with six sources to its left: its left side only has room for a few
        const rects = new Map<string, { x: number; y: number; width: number; height: number }>([
            ['target', { x: 300, y: 100, width: 100, height: 40 }],
        ]);
        const edges: Edge[] = [];
        for (let i = 0; i < 6; i++) {
            rects.set('s' + i, { x: 0, y: i * 50 - 25, width: 100, height: 30 });
            edges.push(edge('s' + i, 'target'));
        }

        const arrows = placeArrows(edges, rects);

        const sides = new Set(arrows.map(function endSide(arrow) {
            return arrow.endSide;
        }));
        assert.ok(sides.has('left'));
        assert.ok(sides.has('top') || sides.has('bottom'));

        // the highest source spills to the top, the lowest to the bottom
        assert.strictEqual(arrows[0].endSide, 'top');
        assert.strictEqual(arrows[5].endSide, 'bottom');
    });
});

suite('arrowWidth', () => {
    test('is thin for one import, thicker for more, and stops at a limit', () => {
        assert.strictEqual(arrowWidth(1), 1.5);
        assert.strictEqual(arrowWidth(2), 2.5);
        assert.strictEqual(arrowWidth(1000), 5);
    });
});

suite('arrowHead', () => {
    // an arrow coming in from the left, ending on a box's left side at (100, 50)
    const arrow = { from: 'a', to: 'b', start: { x: 0, y: 0 }, startSide: 'right' as const, end: { x: 100, y: 50 }, endSide: 'left' as const };

    test('puts a 9px head on a normal arrow, its tip on the end and its base straight out from the side', () => {
        const head = arrowHead(arrow, 1.5);

        assert.strictEqual(head.length, 9);
        assert.strictEqual(head.path, 'M 100 50 L 91 45.5 L 91 54.5 Z');
    });

    test('gives a thicker arrow a bigger head', () => {
        assert.ok(arrowHead(arrow, 5).length > arrowHead(arrow, 1.5).length);
    });

    test('stops the line a gap before the end, straight out from the side', () => {
        assert.ok(arrowPath(arrow, 8).endsWith(', 92 50'));
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

    test('bends only a little out of a side that doesn\'t face where the arrow goes', () => {
        // leaving the top of a box for a target 500 right and only 50 up
        const arrow = {
            from: 'a',
            to: 'b',
            start: { x: 0, y: 0 },
            startSide: 'top' as const,
            end: { x: 500, y: -50 },
            endSide: 'left' as const,
        };

        const pulls = arrowPulls(arrow);

        // half of 50 is under the smallest pull, 30; going in, half of the 500 across
        assert.deepStrictEqual(pulls.first, { x: 0, y: -30 });
        assert.deepStrictEqual(pulls.second, { x: 250, y: -50 });
    });
});
