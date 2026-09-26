/**
 * R3-02 · Structured node:test reporter for the release gate: one JSON line per top-level test result
 * (file, name, pass/fail, skip/todo). The verdict is computed from these events, never from the text
 * summary (which a test could print itself).
 */
import path from 'node:path';

export default async function* reporter(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data;
    if (d.nesting !== 0 || !d.file) continue;
    // A file that registered no test (or exited early) is reported as ONE entry named after the file
    // itself (relative or absolute spelling): flag it, it is not a test.
    const fileLevel = d.name === d.file || path.resolve(d.name) === path.resolve(d.file) || d.name === path.basename(d.file);
    yield `${JSON.stringify({ file: path.basename(d.file), name: d.name, fileLevel, ok: ev.type === 'test:pass',
                              skip: !!d.skip, todo: !!d.todo })}\n`;
  }
}
