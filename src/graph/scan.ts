import { FoundSignals, signalCollector } from './events';
import { FoundImport, importCollector } from './imports';
import { parseFile, walk } from './syntax';

// everything found in one code file, kept once its syntax tree is gone
export interface FileScan {
    imports: FoundImport[];
    signals: FoundSignals; // the events and messages it sends and receives
}

/**
 * Reads a JS or TS file once: parses it, and walks its syntax tree one time, finding its imports, events and messages
 * together. Later kinds of things to find, like functions, become more collectors in the same walk.
 * @param source The full text of the file.
 * @param path The file's path, so .tsx and .jsx files are read with their tags.
 * @returns What was found. The syntax tree itself isn't kept, since trees take far more memory than what's found.
 */
export function scanFile(source: string, path: string): FileScan {
    const file = parseFile(source, path);
    const imports = importCollector(file);
    const signals = signalCollector(file);
    walk(file, [imports, signals]);
    return { imports: imports.finish(), signals: signals.finish() };
}
