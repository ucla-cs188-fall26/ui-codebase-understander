import * as assert from 'assert';
import { buildSignalEdges, FoundSignal, FoundSignals, scanSignals } from '../graph/events';

// a message's field and name, as "field: name", for the message tests
function fieldNames(signals: FoundSignal[]): string[] {
    return signals.map((signal) => signal.field + ': ' + signal.name);
}

// what a test checks about each event or message found: its kind, name, whether it's a constant, and its line
function summary(signals: FoundSignal[]): [string, string, boolean, number][] {
    return signals.map((signal) => [signal.kind, signal.name, signal.isConstant, signal.lines.start]);
}

suite('scanSignals: events', () => {
    test('finds emits and listens written as strings, with their lines', () => {
        const source = [
            "bus.on('saved', refresh);",
            "socket.once('joined', greet);",
            "this.emit('saved', record);",
            'emit(`closed`);',
        ].join('\n');

        const found = scanSignals(source, 'a.ts');

        assert.deepStrictEqual(summary(found.sends), [['event', 'saved', false, 3], ['event', 'closed', false, 4]]);
        assert.deepStrictEqual(summary(found.receives), [['event', 'saved', false, 1], ['event', 'joined', false, 2]]);
    });

    test('counts UPPER_CASE constants as names, on their own or on an object', () => {
        const source = [
            'runner.emit(EVENT_TEST_PASS, test);',
            'runner.on(constants.EVENT_TEST_PASS, report);',
        ].join('\n');

        const found = scanSignals(source, 'a.js');

        assert.deepStrictEqual(summary(found.sends), [['event', 'EVENT_TEST_PASS', true, 1]]);
        assert.deepStrictEqual(summary(found.receives), [['event', 'EVENT_TEST_PASS', true, 2]]);
    });

    test('skips names in ordinary variables, calls in comments and strings, and calls with no name', () => {
        const source = [
            'bus.emit(eventName);',
            "// bus.emit('old');",
            "const text = \"bus.on('fake', f)\";",
            'bus.on();',
        ].join('\n');

        const found = scanSignals(source, 'a.ts');

        assert.deepStrictEqual(found, { sends: [], receives: [] });
    });

    test('skips events Node sends itself, like error and the process signals', () => {
        const source = [
            "child.on('error', fail);",
            "process.on('SIGINT', stop);",
            "this.emit('error', problem);",
            "stream.on('saved', refresh);",
        ].join('\n');

        const found = scanSignals(source, 'a.ts');

        assert.deepStrictEqual(found.sends, []);
        assert.deepStrictEqual(summary(found.receives), [['event', 'saved', false, 4]]);
    });

    test('finds calls inside functions and callbacks, at any depth', () => {
        const source = [
            'function start() {',
            "    server.on('ping', function handle() {",
            "        bus.emit('pinged');",
            '    });',
            '}',
        ].join('\n');

        const found = scanSignals(source, 'a.js');

        assert.deepStrictEqual(summary(found.sends), [['event', 'pinged', false, 3]]);
        assert.deepStrictEqual(summary(found.receives), [['event', 'ping', false, 2]]);
    });

    test('reads .tsx files with their tags', () => {
        const source = [
            'export function Button() {',
            "    return <button onClick={() => bus.emit('pressed')}>Go</button>;",
            '}',
        ].join('\n');

        const found = scanSignals(source, 'Button.tsx');

        assert.deepStrictEqual(summary(found.sends), [['event', 'pressed', false, 2]]);
    });
});

suite('scanSignals: messages', () => {
    test('finds a message posted as an object written in place', () => {
        const source = "vscode.postMessage({ type: 'open', path: path });";

        const found = scanSignals(source, 'a.ts');

        assert.deepStrictEqual(summary(found.sends), [['message', 'open', false, 1]]);
    });

    test('finds a message built in a variable and posted later, at the line it\'s posted', () => {
        const source = [
            'function reply() {',
            "    const message = { type: 'graph', graph: graph };",
            '    panel.webview.postMessage(message);',
            '}',
        ].join('\n');

        const found = scanSignals(source, 'a.ts');

        assert.deepStrictEqual(summary(found.sends), [['message', 'graph', false, 3]]);
    });

    test('doesn\'t take a variable from another function', () => {
        const source = [
            "function one() { const message = { type: 'first' }; }",
            'function two(message) { panel.webview.postMessage(message); }',
        ].join('\n');

        const found = scanSignals(source, 'a.ts');

        assert.deepStrictEqual(found.sends, []);
    });

    test('finds the types a message listener checks for, with === or a switch', () => {
        const source = [
            "window.addEventListener('message', function handle(event) {",
            "    if (event.data.type === 'graph') {",
            '        draw();',
            '    }',
            '    switch (event.data.type) {',
            "        case 'style':",
            '            restyle();',
            '    }',
            '});',
        ].join('\n');

        const found = scanSignals(source, 'a.ts');

        assert.deepStrictEqual(summary(found.receives), [['message', 'graph', false, 2], ['message', 'style', false, 6]]);
    });

    test('counts VS Code\'s onDidReceiveMessage as listening for messages', () => {
        const source = [
            'panel.webview.onDidReceiveMessage(function handle(message) {',
            "    if (message.type === 'ready') {",
            '        send();',
            '    }',
            '});',
        ].join('\n');

        const found = scanSignals(source, 'a.ts');

        assert.deepStrictEqual(summary(found.receives), [['message', 'ready', false, 2]]);
    });

    test('works out the field a handler decides by, whatever it\'s called', () => {
        const source = [
            'window.addEventListener(\'message\', function handle(event) {',
            '    const msg = event.data;',
            '    switch (msg.command) {',
            "        case 'alert': warn(); break;",
            "        case 'refresh': reload(); break;",
            '    }',
            "    if (msg.level === 'high') { flash(); }",
            '});',
        ].join('\n');

        const found = scanSignals(source, 'a.ts');

        // command is checked against two names and level against one, so only command decides
        assert.deepStrictEqual(fieldNames(found.receives), ['command: alert', 'command: refresh']);
    });

    test('sends every field of a posted message that holds a name', () => {
        const source = "vscode.postMessage({ command: 'alert', level: 'high', text: message });";

        const found = scanSignals(source, 'a.ts');

        assert.deepStrictEqual(fieldNames(found.sends), ['command: alert', 'level: high']);
    });

    test('counts a browser extension\'s onMessage and sendMessage', () => {
        const source = [
            "chrome.runtime.sendMessage({ action: 'save' });",
            'chrome.runtime.onMessage.addListener(function handle(request) {',
            "    if (request.action === 'load') { load(); }",
            '});',
        ].join('\n');

        const found = scanSignals(source, 'a.js');

        assert.deepStrictEqual(fieldNames(found.sends), ['action: save']);
        assert.deepStrictEqual(fieldNames(found.receives), ['action: load']);
    });

    test('ignores type checks in a file that doesn\'t listen for messages', () => {
        const source = "if (node.type === 'graph') { draw(); }";

        const found = scanSignals(source, 'a.ts');

        assert.deepStrictEqual(found.receives, []);
    });
});

suite('buildSignalEdges', () => {
    // a send or receive written by hand, on line 1
    function signal(kind: 'event' | 'message', name: string, isConstant = false): FoundSignal {
        return { kind: kind, name: name, isConstant: isConstant, lines: { start: 1, end: 1 } };
    }
    function signals(sends: FoundSignal[], receives: FoundSignal[]): FoundSignals {
        return { sends: sends, receives: receives };
    }
    function ends(edges: { from: string; to: string; kind: string; name?: string }[]): string[][] {
        return edges.map((edge) => [edge.from, edge.to, edge.kind, edge.name!]);
    }

    test('links a sending file to every other file receiving the same thing', () => {
        const signalsByFile = new Map([
            ['store.ts', signals([signal('event', 'saved')], [])],
            ['list.ts', signals([], [signal('event', 'saved')])],
            ['badge.ts', signals([], [signal('event', 'saved'), signal('event', 'cleared')])],
        ]);

        const edges = buildSignalEdges(signalsByFile);

        assert.deepStrictEqual(edges, [
            { from: 'store.ts', to: 'badge.ts', kind: 'event', lines: { start: 1, end: 1 }, name: 'saved' },
            { from: 'store.ts', to: 'list.ts', kind: 'event', lines: { start: 1, end: 1 }, name: 'saved' },
        ]);
    });

    test('skips a file receiving its own, and repeat sends of one name', () => {
        const signalsByFile = new Map([
            ['store.ts', signals([signal('event', 'saved'), signal('event', 'saved')], [signal('event', 'saved')])],
            ['list.ts', signals([], [signal('event', 'saved'), signal('event', 'saved')])],
        ]);

        assert.deepStrictEqual(ends(buildSignalEdges(signalsByFile)), [['store.ts', 'list.ts', 'event', 'saved']]);
    });

    test('makes one edge per name between the same two files', () => {
        const signalsByFile = new Map([
            ['store.ts', signals([signal('event', 'saved'), signal('event', 'cleared')], [])],
            ['list.ts', signals([], [signal('event', 'cleared'), signal('event', 'saved')])],
        ]);

        assert.deepStrictEqual(ends(buildSignalEdges(signalsByFile)), [
            ['store.ts', 'list.ts', 'event', 'saved'],
            ['store.ts', 'list.ts', 'event', 'cleared'],
        ]);
    });

    test('keeps events and messages apart, and constants and strings apart', () => {
        const signalsByFile = new Map([
            ['sender.ts', signals([signal('message', 'open'), signal('event', 'SAVED', true)], [])],
            ['events.ts', signals([], [signal('event', 'open'), signal('event', 'SAVED')])],
            ['panel.ts', signals([], [signal('message', 'open')])],
        ]);

        assert.deepStrictEqual(ends(buildSignalEdges(signalsByFile)), [['sender.ts', 'panel.ts', 'message', 'open']]);
    });

    test('links a message only through the field its receiver decides by', () => {
        const signalsByFile = new Map([
            ['page.ts', scanSignals("vscode.postMessage({ command: 'alert', kind: 'file' });", 'page.ts')],
            ['panel.ts', scanSignals([
                'panel.webview.onDidReceiveMessage(function handle(msg) {',
                "    if (msg.command === 'alert') { warn(); }",
                "    if (msg.command === 'open') { open(); }",
                "    if (msg.kind === 'file') { openFile(); }",
                '});',
            ].join('\n'), 'panel.ts')],
        ]);

        assert.deepStrictEqual(ends(buildSignalEdges(signalsByFile)), [['page.ts', 'panel.ts', 'message', 'alert']]);
    });

    test('makes no edge for something nobody else receives', () => {
        const signalsByFile = new Map([
            ['store.ts', signals([signal('event', 'saved')], [])],
            ['list.ts', signals([], [signal('event', 'loaded')])],
        ]);

        assert.deepStrictEqual(buildSignalEdges(signalsByFile), []);
    });
});
