// Runs the examples in src's TSDoc, and checks that every runtime export of
// every entry point has one. Synced from meta's templates/synced; change it
// there.
//
// An example is a ```ts fence on the line after `@example`. Its imports come
// first, and imports of this package's entry points run against src. A
// `// => <value>` comment, at the end of a statement or on the line after it,
// asserts that the statement, awaited, equals <value>; an object or array
// needs only the fields it names. The value may carry on over the `//` lines
// below. The statement runs back to the blank line, comment, or line ending
// in `;`, `{`, or `}` before it, skipping those inside its own brackets, so
// it may hold a multi-line callback or sit inside a block, but must be an
// expression, not a declaration. `// => throws <Class>` asserts that it
// throws, or rejects with, an instance of <Class>. Every example is
// type-checked with the package's tsconfig; a ```ts no-run fence is
// type-checked but not run, for examples that need the network.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'src');
const out = join(root, '.reports', 'doctest');

interface Example {
  /** Where the `@example` tag is, as `src/file.ts:line`. */
  where: string;
  /** The module it's written to, in `.reports/doctest`. */
  file: string;
  code: string;
  run: boolean;
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, string | { import: string }>;
};

/** Each entry point's specifier, like `@email-utils/classifier/providers`, and its source. */
const entries = new Map<string, string>();
for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (typeof target === 'string') {
    continue;
  }
  const name = target.import.replace(/^\.\/dist\/|\.mjs$/g, '');
  const source = [join(src, `${name}.ts`), join(src, name, 'index.ts')].find(
    (file) => existsSync(file),
  );
  if (source === undefined) {
    throw new Error(`No source for ${subpath}: expected src/${name}.ts`);
  }
  entries.set(pkg.name + subpath.slice(1), source);
}

const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  // oxlint-disable-next-line unicorn/no-array-sort
  .sort()
  .map((file) => join(src, file));

function examplesIn(file: string): Example[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const examples: Example[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\* @example\b/.test(lines[i] ?? '')) {
      continue;
    }
    const where = `${relative(root, file)}:${i + 1}`;
    const fence = /^\s*\* ```ts( no-run)?\s*$/.exec(lines[i + 1] ?? '');
    if (fence === null) {
      throw new Error(
        `${where}: put a \`\`\`ts fence on the line after @example`,
      );
    }
    const code: string[] = [];
    let j = i + 2;
    for (; j < lines.length && !/^\s*\* ```\s*$/.test(lines[j] ?? ''); j++) {
      code.push((lines[j] ?? '').replace(/^\s*\*( |$)/, ''));
    }
    if (j === lines.length) {
      throw new Error(`${where}: the example's fence is never closed`);
    }
    examples.push({
      where,
      file: join(
        out,
        `${where.replace(/^src\//, '').replace(/[/:.]/g, '_')}.ts`,
      ),
      code: code.join('\n'),
      run: fence[1] === undefined,
    });
    i = j;
  }
  return examples;
}

/** `line` without its strings and `//` comment, trimmed. */
function stripped(line: string): string {
  return line
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""')
    .replace(/\/\/.*$/, '')
    .trim();
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** `statement` wrapped in the assertion a `// =>` line makes. */
function assertion(statement: string, value: string): string {
  const thrown = /^throws (\w+)$/.exec(value);
  const matcher = /^[[{]/.test(value) ? 'toMatchObject' : 'toEqual';
  return thrown === null
    ? `expect(await (${statement})).${matcher}(${value});`
    : `await expect(async () => {\n${statement};\n}).rejects.toThrow(${thrown[1]});`;
}

/** The example as a module whose default export runs it. */
function toModule(example: Example, file: string): string {
  // `stmt; // => value` becomes the statement, then the marker below it.
  const lines = example.code
    .replace(/^(\s*\S.*;)[ \t]*(\/\/ =>.*)$/gm, '$1\n$2')
    .split('\n');
  const imports: string[] = [];
  let i = 0;
  // Leading imports, each up to the line that ends it.
  while (i < lines.length && /^import\b/.test(lines[i] ?? '')) {
    for (; i < lines.length; i++) {
      imports.push(lines[i] ?? '');
      if (/;\s*$/.test(lines[i] ?? '')) {
        i++;
        break;
      }
    }
    while ((lines[i] ?? '').trim() === '' && i < lines.length) {
      i++;
    }
  }
  const body: string[] = [];
  for (; i < lines.length; i++) {
    const marker = /^\s*\/\/ =>\s?(.*)$/.exec(lines[i] ?? '');
    if (marker === null) {
      body.push(lines[i] ?? '');
      continue;
    }
    const value = [marker[1] ?? ''];
    while (/^\s*\/\/(?! =>)/.test(lines[i + 1] ?? '')) {
      i++;
      value.push((lines[i] ?? '').replace(/^\s*\/\/ ?/, ''));
    }
    // Back up a line at a time, counting brackets: `depth` is how many the
    // lines taken so far close that they don't open.
    let start = body.length;
    let depth = 0;
    while (start > 0) {
      const above = stripped(body[start - 1] ?? '');
      const last = start === body.length;
      if (depth === 0 && (above === '' || (!last && /[;{}]$/.test(above)))) {
        break;
      }
      const next = depth + count(above, /[)\]}]/g) - count(above, /[([{]/g);
      if (next < 0) {
        // It opens a block the statement sits inside.
        break;
      }
      depth = next;
      start--;
    }
    if (start === body.length || depth !== 0) {
      throw new Error(
        `${example.where}: a // => line has no statement above it`,
      );
    }
    const statement = body.splice(start).join('\n').trim().replace(/;$/, '');
    body.push(assertion(statement, value.join('\n').trim()));
  }
  const source = imports
    .join('\n')
    .replace(
      /(from\s+)(['"])([^'"]+)\2/g,
      (match: string, from: string, quote: string, specifier: string) => {
        const entry = entries.get(specifier);
        if (entry === undefined) {
          return match;
        }
        let path = relative(dirname(file), entry).replace(/\.ts$/, '');
        path = path.startsWith('.') ? path : `./${path}`;
        return `${from}${quote}${path}${quote}`;
      },
    );
  return [
    `import { expect } from 'vitest';`,
    source,
    '',
    'export default async function run(): Promise<void> {',
    ...body,
    '}',
    '',
  ].join('\n');
}

/** The names each doc comment with an example is written on. */
function documented(file: string): string[] {
  const names: string[] = [];
  const text = readFileSync(file, 'utf8');
  const declaration =
    /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|enum)\s+(\w+)/g;
  for (const [, comment, name] of text.matchAll(declaration)) {
    if (comment?.includes('@example') && name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

const withExamples = new Set(files.flatMap(documented));

// Every example's module is written up front, so tsc can check them together.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const examples = files.flatMap(examplesIn);
for (const example of examples) {
  writeFileSync(example.file, toModule(example, example.file));
}
writeFileSync(
  join(out, 'tsconfig.json'),
  JSON.stringify({ extends: '../../tsconfig.json', include: ['*.ts'] }),
);

async function load(example: Example): Promise<() => Promise<void>> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const module = (await import(example.file)) as {
    default: () => Promise<void>;
  };
  return module.default;
}

describe('TSDoc examples', () => {
  it('type-check', { timeout: 60_000 }, () => {
    const tsc = spawnSync(
      process.execPath,
      [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', out],
      { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
    );
    // Each error names the example, not its generated module.
    let errors = tsc.stdout.trim();
    for (const example of examples) {
      errors = errors.replaceAll(
        relative(root, example.file),
        `${example.where} (as ${basename(example.file)})`,
      );
    }
    expect(errors).toBe('');
    expect(tsc.status).toBe(0);
  });

  // oxlint-disable-next-line vitest/expect-expect
  it.each(examples.filter((example) => example.run))(
    'runs $where',
    async (example) => {
      const run = await load(example);
      await run();
    },
  );

  it.each(examples.filter((example) => !example.run))(
    'compiles $where',
    async (example) => {
      expect(await load(example)).toBeTypeOf('function');
    },
  );
});

describe('every runtime export has an example', () => {
  it.each([...entries])('%s', async (_, source) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const module = (await import(source)) as Record<string, unknown>;
    expect(
      Object.keys(module).filter((name) => !withExamples.has(name)),
    ).toEqual([]);
  });
});
