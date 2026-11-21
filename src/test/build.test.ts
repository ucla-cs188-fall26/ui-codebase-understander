import * as assert from 'assert';
import { buildEdges, buildTree } from '../graph/build';
import { FoundImport, scanImports } from '../graph/imports';
import { resolveImport } from '../graph/resolve';
import { scanFile } from '../graph/scan';

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
        // each import on its own line, numbered in order
        function onLines(paths: string[]): FoundImport[] {
            return paths.map((path, index) => ({ path: path, lines: { start: index + 1, end: index + 1 } }));
        }
        const importsByFile = new Map<string, FoundImport[]>([
            ['README.md', []],
            ['src/app.ts', onLines(['./lib/b', './lib/b.js', './app', 'react'])],
            ['src/lib/b.ts', onLines(['../../README.md'])],
        ]);

        const edges = buildEdges(importsByFile);

        // the repeat import of b keeps the first one's line
        assert.deepStrictEqual(edges, [
            { from: 'src/app.ts', to: 'src/lib/b.ts', kind: 'import', lines: { start: 1, end: 1 } },
            { from: 'src/lib/b.ts', to: 'README.md', kind: 'import', lines: { start: 1, end: 1 } },
        ]);
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

        assert.deepStrictEqual(imports, [
            { path: './a', lines: { start: 2, end: 2 } },
            { path: './b', lines: { start: 4, end: 4 } },
        ]);
    });

    test('gives an import written across lines the line its path is on', () => {
        const source = [
            'const x = 1;',
            'const {',
            '  a,',
            '  b,',
            "} = require('./x');",
        ].join('\n');

        const imports = scanImports(source);

        assert.deepStrictEqual(imports, [{ path: './x', lines: { start: 5, end: 5 } }]);
    });

    test('finds every way of importing, including types and re-exports', () => {
        const source = [
            "import type { Shape } from './shape';",
            "export * as tools from './tools';",
            "export { draw } from './draw';",
            "import fs = require('./fs');",
            "const later = import('./later');",
            "let size: import('./size').Size;",
            "declare module './plugin' {",
            '    interface Options {}',
            '}',
        ].join('\n');

        const imports = scanImports(source);

        assert.deepStrictEqual(imports.map((found) => found.path), [
            './shape', './tools', './draw', './fs', './later', './size', './plugin',
        ]);
    });

    test('a declare module in a file without imports or exports declares a module, rather than importing one', () => {
        const source = "declare module 'some-package' {\n    export const value: number;\n}";

        assert.deepStrictEqual(scanImports(source), []);
    });
});

suite('scanFile', () => {
    test('finds imports, events and messages in one read', () => {
        const source = [
            "import { bus } from './bus';",
            "bus.emit('saved');",
            "vscode.postMessage({ type: 'open' });",
        ].join('\n');

        const scan = scanFile(source, 'a.ts');

        assert.deepStrictEqual(scan.imports, [{ path: './bus', lines: { start: 1, end: 1 } }]);
        assert.deepStrictEqual(scan.signals.sends.map((signal) => signal.kind + ' ' + signal.name), ['event saved', 'message open']);
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
