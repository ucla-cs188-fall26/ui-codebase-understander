import * as assert from 'assert';
import { fitCamera, MAX_SCALE, zoomAt } from '../layout/camera';
import { boundsOf, subtractRect } from '../layout/geometry';

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

suite('boundsOf', () => {
    test('finds the smallest rectangle around every box', () => {
        const rects = [{ x: 0, y: 0, width: 100, height: 50 }, { x: 200, y: 100, width: 50, height: 50 }];

        assert.deepStrictEqual(boundsOf(rects), { x: 0, y: 0, width: 250, height: 150 });
        assert.strictEqual(boundsOf([]), undefined);
    });
});

suite('subtractRect', () => {
    test('leaves a box alone when the other doesn\'t overlap it', () => {
        const a = { x: 0, y: 0, width: 100, height: 50 };

        assert.deepStrictEqual(subtractRect(a, { x: 200, y: 0, width: 50, height: 50 }), [a]);
    });

    test('leaves the parts around a hole in the middle, without overlapping', () => {
        const pieces = subtractRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 40, y: 40, width: 20, height: 20 });

        assert.deepStrictEqual(pieces, [
            { x: 0, y: 0, width: 100, height: 40 },
            { x: 0, y: 60, width: 100, height: 40 },
            { x: 0, y: 40, width: 40, height: 20 },
            { x: 60, y: 40, width: 40, height: 20 },
        ]);
    });

    test('leaves nothing when the other covers it', () => {
        assert.deepStrictEqual(subtractRect({ x: 10, y: 10, width: 20, height: 20 }, { x: 0, y: 0, width: 100, height: 100 }), []);
    });
});

suite('fitCamera', () => {
    test('centers a small graph without enlarging it', () => {
        const camera = fitCamera({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 1000, height: 800 }, 40);

        // it would fit at 7.2x, but it stays at full size, its center at the viewport's center (500, 400)
        assert.deepStrictEqual(camera, { x: 450, y: 350, scale: 1 });
    });

    test('shrinks a big graph until it fits both ways', () => {
        const camera = fitCamera({ x: 0, y: 0, width: 2000, height: 1000 }, { x: 0, y: 0, width: 1000, height: 800 }, 0);

        // the width is the tighter fit: 1000 / 2000 = 0.5
        assert.deepStrictEqual(camera, { x: 0, y: 150, scale: 0.5 });
    });
});
