import * as assert from 'assert';
import { squishHorizontally, squishVertically, tightHeight, tightWidth } from '../layout/squish';

suite('squishHorizontally', () => {
    // one row of 100x50 boxes, 40 apart: a at 0, b at 140, c at 280, d at 420; and e alone in a row below
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
        assert.strictEqual(squished.fits, true);
    });

    test('shrinks every gap in a row evenly, keeping the order', () => {
        const squished = squishHorizontally(makeRow(), 480);

        // the three 40px gaps shrink together until d ends at the wall: 480 - 4 x 100 = 80 left, so 80 / 3 each
        const gapAB = xOf(squished.rects, 'b') - xOf(squished.rects, 'a') - 100;
        const gapBC = xOf(squished.rects, 'c') - xOf(squished.rects, 'b') - 100;
        const gapCD = xOf(squished.rects, 'd') - xOf(squished.rects, 'c') - 100;
        assert.ok(Math.abs(gapAB - 80 / 3) < 0.001);
        assert.ok(Math.abs(gapBC - gapAB) < 0.001);
        assert.ok(Math.abs(gapCD - gapAB) < 0.001);
        assert.ok(Math.abs(xOf(squished.rects, 'd') + 100 - 480) < 0.001);
    });

    test('says it doesn\'t fit when the gaps are already as small as they go and the row still sticks out', () => {
        // two boxes MIN_GAP apart, starting at the wall: nothing left to shrink, and they need 210
        const rects = new Map([
            ['a', { x: 0, y: 0, width: 100, height: 50 }],
            ['b', { x: 110, y: 0, width: 100, height: 50 }],
        ]);

        const squished = squishHorizontally(rects, 150);

        assert.strictEqual(squished.fits, false);
    });

    test('packs a row that doesn\'t fit as tight as it goes', () => {
        // four boxes need at least 4 x 100 + 3 x 10 = 430
        const squished = squishHorizontally(makeRow(), 400);

        assert.strictEqual(squished.fits, false);
        assert.deepStrictEqual(['a', 'b', 'c', 'd'].map(function at(id) {
            return xOf(squished.rects, id);
        }), [0, 110, 220, 330]);
    });

    test('leaves other rows alone', () => {
        const squished = squishHorizontally(makeRow(), 400);

        assert.strictEqual(xOf(squished.rects, 'e'), 0);
    });

    test('fits a row exactly as wide as it packs to, give or take rounding', () => {
        assert.strictEqual(squishHorizontally(makeRow(), 430 - 0.0000000001).fits, true);
        assert.strictEqual(squishHorizontally(makeRow(), 429).fits, false);
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

        // as narrow as it goes: the three columns side by side, each as wide as its widest box
        const narrowest = tightWidth(staggered);
        assert.strictEqual(narrowest, 400 + 400 + 300 + 2 * 10);
        assert.strictEqual(squishHorizontally(staggered, narrowest).fits, true);
    });

    test('finds the narrowest width every row fits in', () => {
        // the long row: 4 x 100 + 3 x 10
        assert.strictEqual(tightWidth(makeRow()), 430);
    });
});

suite('squishVertically', () => {
    // one column of 100x50 boxes, 40 apart: a at 0, b at 90, c at 180, d at 270
    function makeColumn() {
        return new Map([
            ['a', { x: 0, y: 0, width: 100, height: 50 }],
            ['b', { x: 0, y: 90, width: 100, height: 50 }],
            ['c', { x: 0, y: 180, width: 100, height: 50 }],
            ['d', { x: 0, y: 270, width: 100, height: 50 }],
        ]);
    }

    test('shrinks gaps evenly from the bottom, until they\'re as small as they go', () => {
        // 310 - 4 x 50 = 110 left for the three gaps, so 110 / 3 each, and d ends at the bottom
        const squeezed = squishVertically(makeColumn(), 310);
        const gapAB = squeezed.rects.get('b')!.y - squeezed.rects.get('a')!.y - 50;
        const gapCD = squeezed.rects.get('d')!.y - squeezed.rects.get('c')!.y - 50;
        assert.ok(Math.abs(gapAB - 110 / 3) < 0.001);
        assert.ok(Math.abs(gapCD - gapAB) < 0.001);
        assert.ok(Math.abs(squeezed.rects.get('d')!.y + 50 - 310) < 0.001);

        // four need 4 x 50 + 3 x 10 = 230
        assert.strictEqual(squishVertically(makeColumn(), 220).fits, false);
    });

    test('finds the shortest height every column fits in', () => {
        assert.strictEqual(tightHeight(makeColumn()), 4 * 50 + 3 * 10);
    });
});
