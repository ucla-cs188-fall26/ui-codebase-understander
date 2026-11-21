import * as assert from 'assert';
import { createLayoutState, openNode } from '../layout/state';
import { fromSaved, toSaved } from '../layout/saved';
import { ROOT_ID } from '../graph/types';
import { makeInfo } from './helpers';

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
        const text = JSON.stringify(toSaved(state, camera, 'hidden', 3));
        const restored = fromSaved(JSON.parse(text), info);

        assert.deepStrictEqual(restored.state, state);
        assert.deepStrictEqual(restored.camera, camera);
        assert.strictEqual(restored.arrowMode, 'hidden');
        assert.strictEqual(restored.arrowDepth, 3);
    });

    test('drops anything about nodes that no longer exist', () => {
        const info = makeInfo();
        const saved = toSaved(createLayoutState(), { x: 0, y: 0, scale: 1 }, 'default', 1);
        saved.expanded.push('deleted');
        saved.homes.push(['deleted/file.ts', { x: 1, y: 1 }]);

        const restored = fromSaved(saved, info);

        assert.ok(!restored.state.expanded.has('deleted'));
        assert.ok(!restored.state.homes.has('deleted/file.ts'));
    });

    test('uses the default arrow settings for a layout saved before the settings existed', () => {
        const info = makeInfo();
        const saved = toSaved(createLayoutState(), { x: 0, y: 0, scale: 1 }, 'full', 4);
        delete saved.arrowMode;
        delete saved.arrowDepth;

        const restored = fromSaved(saved, info);

        assert.strictEqual(restored.arrowMode, 'default');
        assert.strictEqual(restored.arrowDepth, 1);
    });

    test('uses depth 1 for a depth that isn\'t a number, like one saved when the depth was picked from a list', () => {
        const info = makeInfo();
        const saved = JSON.parse(JSON.stringify(toSaved(createLayoutState(), { x: 0, y: 0, scale: 1 }, 'full', 4)));
        saved.arrowDepth = 'all';

        const restored = fromSaved(saved, info);

        assert.strictEqual(restored.arrowDepth, 1);
    });
});
