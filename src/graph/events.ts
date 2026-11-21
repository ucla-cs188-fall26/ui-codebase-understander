import * as ts from 'typescript';
import { posix } from 'path';
import { Edge, LineRange } from './types';

// method names that send an event, and ones that listen for it, as Node's EventEmitter and socket.io name them
const EMIT_METHODS = ['emit'];
const LISTEN_METHODS = ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'];

// events Node itself sends, from streams, processes, servers and sockets. A file listening for one is almost always
// listening to Node, not to another file, so these never make edges. Names starting with SIG, the process signals, are
// left out too
const NODE_EVENTS = [
    'error', 'close', 'end', 'data', 'finish', 'drain', 'readable', 'exit', 'message', 'connection', 'listening',
    'request', 'response', 'timeout',
];

// method names that send a message to another window, frame, worker, webview or browser extension part. Plain send()
// is left out: it's mostly something else, like replying to a web request
const POST_METHODS = ['postMessage', 'sendMessage'];

// how one file reaches another by name: an emitted event, or a message posted to another window, webview or worker
export type SignalKind = 'event' | 'message';

// an event or message name written in a file, and the lines the call or check is on
export interface FoundSignal {
    kind: SignalKind;
    name: string;
    isConstant: boolean; // named by an UPPER_CASE constant, like EVENT_SAVED, rather than written out as a string
    field?: string; // for a message, the property its name is in, like type in { type: 'open' }
    lines: LineRange;
}

// the events and messages a file sends and receives
export interface FoundSignals {
    sends: FoundSignal[];
    receives: FoundSignal[];
}

/**
 * Finds every event and message a JS or TS file sends or receives by name.
 * - Events: emitter.emit('saved') sends, and emitter.on('saved', ...) receives.
 * - Messages: posting an object, like postMessage({ command: 'alert', text: text }), sends each of its fields that
 *   holds a name. A file that listens for messages receives the names it checks for, like msg.command === 'alert' or
 *   case 'alert': in a switch on msg.command, but only for the field it decides by: the one it checks against the
 *   most names. Codebases call that field different things (type, command, action), so it's found, not assumed.
 * A name counts if it's written as a string, or as an UPPER_CASE constant like EVENT_SAVED, which other files can use
 * too. Anything else, like a name in a variable, can't be read without running the code, so it's skipped. Calls in
 * comments and strings aren't calls, so they're skipped too.
 * @param source The full text of the file.
 * @param path The file's path, so .tsx and .jsx files are read with their tags.
 * @returns What it sends and what it receives, each in the order they're written.
 */
export function scanSignals(source: string, path: string): FoundSignals {
    const extension = posix.extname(path);
    const hasTags = extension === '.tsx' || extension === '.jsx';
    const scriptKind = hasTags ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const setParentNodes = false;
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, setParentNodes, scriptKind);

    const found: FoundSignals = { sends: [], receives: [] };

    // checks of a field against a name, like msg.command === 'alert', which only count once it's known the file
    // listens for messages, and only for the field it decides by
    const checks: FoundSignal[] = [];
    let listensForMessages = false;

    // messages built before they're posted, like const reply = { type: 'graph' }, by variable name, one map per
    // function so a name used in two functions isn't mixed up
    const scopes: Map<string, FieldName[]>[] = [new Map()];

    function lineOf(node: ts.Node): LineRange {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        return { start: line, end: line };
    }

    function add(list: FoundSignal[], kind: SignalKind, name: Name, node: ts.Node, field?: string): void {
        const signal: FoundSignal = { kind: kind, name: name.text, isConstant: name.isConstant, lines: lineOf(node) };
        if (field !== undefined) {
            signal.field = field;
        }
        list.push(signal);
    }

    function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
            visitCall(node);
        }

        // a message built in a variable, to be posted later in the same function
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
            const fields = namedFields(node.initializer);
            if (fields.length > 0) {
                scopes[scopes.length - 1].set(node.name.text, fields);
            }
        }

        // a check like msg.command === 'alert', either way round
        if (ts.isBinaryExpression(node) && isEquality(node.operatorToken.kind)) {
            const left = fieldRead(node.left);
            const right = fieldRead(node.right);
            if (left !== undefined) {
                addCheck(left, node.right, node);
            } else if (right !== undefined) {
                addCheck(right, node.left, node);
            }
        }

        // a switch on a field, with a case for each name
        if (ts.isSwitchStatement(node)) {
            const field = fieldRead(node.expression);
            if (field !== undefined) {
                for (const clause of node.caseBlock.clauses) {
                    if (ts.isCaseClause(clause)) {
                        addCheck(field, clause.expression, clause);
                    }
                }
            }
        }

        // worker.onmessage = ... listens for messages too
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'onmessage') {
            listensForMessages = true;
        }

        // every node inside, with a new scope for each function
        const isFunction = ts.isFunctionLike(node);
        if (isFunction) {
            scopes.push(new Map());
        }
        ts.forEachChild(node, visit);
        if (isFunction) {
            scopes.pop();
        }
    }

    function addCheck(field: string, compared: ts.Expression, node: ts.Node): void {
        const name = nameOf(compared);
        if (name !== undefined) {
            add(checks, 'message', name, node, field);
        }
    }

    function visitCall(call: ts.CallExpression): void {
        const method = methodName(call);
        if (method === undefined) {
            return;
        }
        const first = call.arguments[0];
        const firstName = first === undefined ? undefined : nameOf(first);

        if (isMessageListener(call, method, firstName)) {
            listensForMessages = true;
        }

        if (POST_METHODS.includes(method) && first !== undefined) {
            for (const field of postedFields(first)) {
                add(found.sends, 'message', field.name, call, field.field);
            }
            return;
        }

        if (firstName === undefined || isNodeEvent(firstName)) {
            return;
        }
        if (EMIT_METHODS.includes(method)) {
            add(found.sends, 'event', firstName, call);
        } else if (LISTEN_METHODS.includes(method)) {
            add(found.receives, 'event', firstName, call);
        }
    }

    // the fields that hold a name in what a post sends: a message written in place, or one built in a variable before
    function postedFields(posted: ts.Expression): FieldName[] {
        if (ts.isIdentifier(posted)) {
            for (let i = scopes.length - 1; i >= 0; i--) {
                const fields = scopes[i].get(posted.text);
                if (fields !== undefined) {
                    return fields;
                }
            }
            return [];
        }
        return namedFields(posted);
    }

    visit(file);

    if (listensForMessages) {
        const fields = decidingFields(checks);
        for (const check of checks) {
            if (fields.has(check.field!)) {
                found.receives.push(check);
            }
        }
        found.receives.sort(function byLine(a: FoundSignal, b: FoundSignal): number {
            return a.lines.start - b.lines.start;
        });
    }
    return found;
}

// an event or message name as it's written: its text, and whether it's a constant's name or a string
interface Name {
    text: string;
    isConstant: boolean;
}

// a field of a posted message that holds a name, like command and 'alert' in { command: 'alert' }
interface FieldName {
    field: string;
    name: Name;
}

/**
 * Reads a name written as a string, like 'saved', or as an UPPER_CASE constant, like EVENT_SAVED or
 * constants.EVENT_SAVED.
 * @param expression What's written where the name goes.
 * @returns The name, or undefined for anything else, like a variable in camelCase or a string built at runtime.
 */
function nameOf(expression: ts.Expression): Name | undefined {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        return { text: expression.text, isConstant: false };
    }
    let identifier: string | undefined = undefined;
    if (ts.isIdentifier(expression)) {
        identifier = expression.text;
    } else if (ts.isPropertyAccessExpression(expression)) {
        identifier = expression.name.text;
    }
    if (identifier !== undefined && /^[A-Z][A-Z0-9_]*$/.test(identifier)) {
        return { text: identifier, isConstant: true };
    }
    return undefined;
}

/**
 * Finds the name of the function a call calls: emit for both emitter.emit(...) and a bare emit(...).
 * @param call The call.
 * @returns The name, or undefined for a call like handlers[0](...) that has none.
 */
function methodName(call: ts.CallExpression): string | undefined {
    if (ts.isPropertyAccessExpression(call.expression)) {
        return call.expression.name.text;
    }
    if (ts.isIdentifier(call.expression)) {
        return call.expression.text;
    }
    return undefined;
}

/**
 * Checks whether a call starts listening for messages:
 * - addEventListener('message', ...) in a browser, frame or worker
 * - on('message', ...) and the like, for Node's worker threads, child processes and sockets
 * - webview.onDidReceiveMessage(...) in a VS Code extension
 * - runtime.onMessage.addListener(...) in a browser extension
 * @param call The call.
 * @param method The name of the function it calls.
 * @param firstName The name passed first, if any.
 * @returns True if it listens for messages.
 */
function isMessageListener(call: ts.CallExpression, method: string, firstName: Name | undefined): boolean {
    if (method === 'onDidReceiveMessage') {
        return true;
    }
    if ((method === 'addEventListener' || LISTEN_METHODS.includes(method)) && firstName?.text === 'message') {
        return true;
    }
    const callee = call.expression;
    return method === 'addListener' && ts.isPropertyAccessExpression(callee)
        && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'onMessage';
}

/**
 * Reads the fields of an object written out in place that hold a name, like both fields in
 * { command: 'alert', level: 'warning' }, but not text: text.
 * @param expression The object.
 * @returns Each such field and its name, in the order written; nothing if it isn't an object.
 */
function namedFields(expression: ts.Expression): FieldName[] {
    const fields: FieldName[] = [];
    if (!ts.isObjectLiteralExpression(expression)) {
        return fields;
    }
    for (const property of expression.properties) {
        if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
            const name = nameOf(property.initializer);
            if (name !== undefined) {
                fields.push({ field: property.name.text, name: name });
            }
        }
    }
    return fields;
}

/**
 * Finds the field something reads, like command in msg.command or event.data.command.
 * @param expression What's written.
 * @returns The field's name, or undefined if it doesn't read a field.
 */
function fieldRead(expression: ts.Expression): string | undefined {
    if (ts.isPropertyAccessExpression(expression)) {
        return expression.name.text;
    }
    return undefined;
}

/**
 * Finds the fields a file decides what to do with a message by: the ones it checks against the most different names.
 * A handler checks its deciding field, like command, against every name it handles, and other fields, like a file's
 * kind, against a few at most.
 * @param checks Every check in the file of a field against a name.
 * @returns The fields checked against the most different names; more than one if they tie.
 */
function decidingFields(checks: FoundSignal[]): Set<string> {
    const namesByField = new Map<string, Set<string>>();
    for (const check of checks) {
        const names = namesByField.get(check.field!) ?? new Set<string>();
        names.add(check.name);
        namesByField.set(check.field!, names);
    }
    let most = 0;
    for (const names of namesByField.values()) {
        most = Math.max(most, names.size);
    }
    const fields = new Set<string>();
    for (const [field, names] of namesByField) {
        if (names.size === most) {
            fields.add(field);
        }
    }
    return fields;
}

/**
 * Checks whether an operator compares for equality.
 * @param operator The operator's kind.
 * @returns True for === and ==.
 */
function isEquality(operator: ts.SyntaxKind): boolean {
    return operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
}

/**
 * Checks whether an event name is one Node sends itself, like 'error' or 'SIGINT'.
 * @param name The name.
 * @returns True for a string in NODE_EVENTS or starting with SIG; constants never are.
 */
function isNodeEvent(name: Name): boolean {
    return !name.isConstant && (NODE_EVENTS.includes(name.text) || name.text.startsWith('SIG'));
}

/**
 * Turns what each file sends and receives into edges: one from a file that sends an event or message to each other
 * file that receives the same one, since that's where the code goes next when it's sent. The same means the same kind,
 * field and name, written the same way: the constant SAVED and the string 'SAVED' are kept apart, since nothing says
 * the constant holds that string.
 * @param signalsByFile Every code file, mapped to what it sends and receives, from scanSignals.
 * @returns One edge per sending file, receiving file, kind and name, carrying the lines of the first send of it in the
 *   sending file. A file receiving its own event or message gets no edge.
 */
export function buildSignalEdges(signalsByFile: Map<string, FoundSignals>): Edge[] {
    const sortedFiles = Array.from(signalsByFile.keys()).toSorted();

    // which files receive each event or message
    const receiversByKey = new Map<string, string[]>();
    for (const file of sortedFiles) {
        for (const receive of signalsByFile.get(file)!.receives) {
            const receivers = receiversByKey.get(signalKey(receive)) ?? [];
            if (!receivers.includes(file)) {
                receivers.push(file);
            }
            receiversByKey.set(signalKey(receive), receivers);
        }
    }

    const edges: Edge[] = [];
    for (const fromFile of sortedFiles) {
        // only the first send of each in a file makes edges, the same as only the first import of a file does
        const sent = new Set<string>();
        for (const send of signalsByFile.get(fromFile)!.sends) {
            const key = signalKey(send);
            if (sent.has(key)) {
                continue;
            }
            sent.add(key);

            for (const toFile of receiversByKey.get(key) ?? []) {
                if (toFile !== fromFile) {
                    edges.push({ from: fromFile, to: toFile, kind: send.kind, lines: send.lines, name: send.name });
                }
            }
        }
    }
    return edges;
}

/**
 * Names an event or message for matching a send to its receives.
 * @param signal The event or message.
 * @returns Its kind, field, whether it's a constant, and its name, like "message command string alert".
 */
function signalKey(signal: FoundSignal): string {
    return signal.kind + ' ' + (signal.field ?? '') + (signal.isConstant ? ' constant ' : ' string ') + signal.name;
}
