// Writes the public API report: api/<entry>.api.md for each entry point in
// package.json's `exports`, from the built declarations, with API Extractor.
// Each report lists the entry's exports and the types they refer to, sorted
// and without doc comments. Synced from meta's templates/synced; change it
// there.
//
//   npm run api              # build, then write api/; commit what changes
//   npm run check:package    # fails when api/ doesn't match the build
//
// `--check` writes nothing and fails on any difference. meta's api-report.yml
// then reads a PR's changes to api/ and checks that its title releases them:
// `feat` for additions, `!` for removals or changes (meta#16).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel,
} from '@microsoft/api-extractor';
import pkg from '../package.json' with { type: 'json' };

const check = process.argv.includes('--check');
const root = resolve(import.meta.dirname, '..');
const dir = join(root, 'api');
const scratch = join(root, '.reports', 'api');

/** `.` is `index`, and `./x/y` is `x-y`. */
function reportName(subpath: string): string {
  return subpath === '.' ? 'index' : subpath.slice(2).replaceAll('/', '-');
}

function list(files: string[]): string {
  return files.map((file) => `api/${file}`).join(', ');
}

// `./package.json` is metadata, and a pattern has no single entry.
const entries = Object.entries(pkg.exports).flatMap(([subpath, target]) =>
  typeof target === 'string' || subpath.includes('*')
    ? []
    : [
        {
          name: reportName(subpath),
          types: join(root, target.import.replace(/\.mjs$/, '.d.mts')),
        },
      ],
);

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

// Reports that differ from the build, and those whose entry point is gone.
const updated: string[] = [];
const removed: string[] = [];
for (const { name, types } of entries) {
  if (!existsSync(types)) {
    process.stderr.write(`${types} is missing. Run \`npm run build\` first.\n`);
    process.exit(1);
  }
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: root,
      mainEntryPointFilePath: types,
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            module: 'nodenext',
            moduleResolution: 'nodenext',
            strict: true,
            types: ['node'],
          },
        },
      },
      apiReport: {
        enabled: true,
        reportFolder: scratch,
        reportTempFolder: join(scratch, 'temp'),
        reportFileName: name,
        // Types the API uses but the entry doesn't export are still its API.
        includeForgottenExports: true,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      newlineKind: 'lf',
      // The report is the check; the TSDoc has its own lint.
      messages: {
        extractorMessageReporting: {
          default: {
            logLevel: ExtractorLogLevel.None,
            addToApiReportFile: false,
          },
        },
        tsdocMessageReporting: {
          default: { logLevel: ExtractorLogLevel.None },
        },
      },
    },
    configObjectFullPath: undefined,
    packageJsonFullPath: join(root, 'package.json'),
  });
  const result = Extractor.invoke(config, {
    localBuild: true,
    // Its notes about the bundled TypeScript and the report file.
    messageCallback: (message) => {
      if (message.messageId.startsWith('console-')) {
        message.handled = true;
      }
    },
  });
  if (!result.succeeded) {
    process.stderr.write(`API Extractor failed on ${types}.\n`);
    process.exit(1);
  }

  const file = `${name}.api.md`;
  const report = readFileSync(join(scratch, file), 'utf8');
  const committed = join(dir, file);
  if (existsSync(committed) && readFileSync(committed, 'utf8') === report) {
    continue;
  }
  updated.push(file);
  if (!check) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(committed, report);
  }
}

const names = new Set(entries.map(({ name }) => `${name}.api.md`));
for (const file of existsSync(dir) ? readdirSync(dir) : []) {
  if (names.has(file)) {
    continue;
  }
  removed.push(file);
  if (!check) {
    rmSync(join(dir, file));
  }
}

const failures = [...updated, ...removed];
if (!check) {
  if (updated.length > 0) {
    process.stdout.write(`Updated ${list(updated)}.\n`);
  }
  if (removed.length > 0) {
    process.stdout.write(`Removed ${list(removed)}.\n`);
  }
  if (failures.length === 0) {
    process.stdout.write('api/ is up to date.\n');
  }
} else if (failures.length > 0) {
  // The diff names what changed; `git diff --no-index` exits 1 on any.
  for (const file of failures) {
    const report = join(scratch, file);
    spawnSync(
      'git',
      [
        'diff',
        '--no-index',
        '--no-color',
        existsSync(join(dir, file)) ? join('api', file) : '/dev/null',
        existsSync(report) ? join('.reports', 'api', file) : '/dev/null',
      ],
      { cwd: root, stdio: 'inherit' },
    );
  }
  process.stderr.write(
    `${list(failures)} don't match the build. ` +
      'Run `npm run api` and commit api/.\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write('api/ is up to date.\n');
}
