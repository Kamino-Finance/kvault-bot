import fs from 'fs';
import path from 'path';
import { address, Address } from '@solana/kit';

/**
 * Generic settings engine: declarations, typed env readers, doc renderers and the drift scanner.
 * Holds no bot-specific content; a fork declares its own settings and reuses this module.
 */

export type SettingKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'address'
  | 'addressList'
  | 'url'
  | 'path'
  | 'json'
  | 'custom';

export type Component = 'process' | 'invest' | 'allocation' | 'danger' | 'tx' | 'logger' | 'cli';

export type SettingDefault = string | number | boolean;

export interface SettingSpec {
  /** Environment variable name. A name ending in `*` declares a prefix family, e.g. `RPC_READ_*`. */
  readonly name: string;
  /** Section title in `.env.example` and the README. */
  readonly group: string;
  /** One or two sentences. */
  readonly description: string;
  readonly kind: SettingKind;
  /** Documented default. Omit when there is none. The typed readers return it when the variable is absent. */
  readonly default?: SettingDefault;
  /** Value shown in `.env.example` when it differs from the default, e.g. `${RPC}`. */
  readonly example?: string;
  /** Starting-profile value. `.env.example` emits the setting uncommented with this value. */
  readonly starter?: SettingDefault;
  /** `true`: always required. `'production'`: required when NODE_ENV is `production`. */
  readonly required?: true | 'production';
  readonly usedBy: readonly Component[];
  /** For a number: the problem with a present value, e.g. `must be a positive safe integer`; undefined when valid. */
  readonly validate?: (value: number) => string | undefined;
}

/** Rules for `SettingSpec.validate`. */
export const positiveSafeInteger = (value: number) =>
  Number.isSafeInteger(value) && value > 0 ? undefined : 'must be a positive safe integer';
export const nonNegativeSafeInteger = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 ? undefined : 'must be a non-negative safe integer';
export const nonNegativeFiniteNumber = (value: number) =>
  Number.isFinite(value) && value >= 0 ? undefined : 'must be a non-negative finite number';

export interface ConfigFieldSpec {
  readonly name: string;
  readonly level: 'entry' | 'vault' | 'both';
  readonly required: boolean;
  /** Short type text, e.g. `number` or `string[] | { reserve, weight }[]`. */
  readonly type: string;
  /** Default as markdown text, e.g. `` `3600` `` or `entry value`. Omit when there is none. */
  readonly default?: string;
  readonly description: string;
  /** Strategies the field applies to. Empty or absent means all strategies. */
  readonly strategies?: readonly string[];
  /** Throws when a present value is invalid. The loader calls it for every configured occurrence. */
  readonly validate?: (value: unknown, fieldPath: string) => void;
}

/**
 * Declares a settings object keyed by env name. The key must equal the spec's `name` (compile-time check),
 * and the `const` type parameter keeps literal kinds and defaults so the readers can pick their overloads.
 */
export function defineSettings<const T extends { readonly [K in keyof T]: SettingSpec & { readonly name: K } }>(
  settings: T
): T {
  return settings;
}

// ---------------------------------------------------------------------------------------------------------------
// Typed readers for declared settings.
// ---------------------------------------------------------------------------------------------------------------

type KindSpec<K extends SettingKind, D extends SettingDefault> = SettingSpec & {
  readonly kind: K;
  readonly default?: D;
};
export type KindSpecWithDefault<K extends SettingKind, D extends SettingDefault> = KindSpec<K, D> & {
  readonly default: D;
};

/** The raw value when the variable is present (`in process.env`), after the `required` check. */
function readPresent(spec: SettingSpec): string | undefined {
  if (spec.name in process.env) {
    return process.env[spec.name] as string;
  }
  if (spec.required === true || (spec.required === 'production' && process.env.NODE_ENV === 'production')) {
    throw Error(`${spec.name} environment variable does not exist`);
  }
  return undefined;
}

export function readString(spec: KindSpecWithDefault<'string', string>): string;
export function readString(spec: KindSpec<'string', string>): string | undefined;
export function readString(spec: KindSpec<'string', string>): string | undefined {
  return readPresent(spec) ?? spec.default;
}

export function readUrl(spec: KindSpecWithDefault<'url', string>): string;
export function readUrl(spec: KindSpec<'url', string>): string | undefined;
export function readUrl(spec: KindSpec<'url', string>): string | undefined {
  return readPresent(spec) ?? spec.default;
}

export function readPath(spec: KindSpecWithDefault<'path', string>): string;
export function readPath(spec: KindSpec<'path', string>): string | undefined;
export function readPath(spec: KindSpec<'path', string>): string | undefined {
  return readPresent(spec) ?? spec.default;
}

export function readNumber(spec: KindSpecWithDefault<'number', number>): number;
export function readNumber(spec: KindSpec<'number', number>): number | undefined;
export function readNumber(spec: KindSpec<'number', number>): number | undefined {
  const rawValue = readPresent(spec);
  if (rawValue === undefined) {
    return spec.default;
  }
  const value = Number(rawValue);
  // Number('') is 0: a blank value would turn a gate or a cooldown off without an error.
  if (rawValue.trim() === '' || !Number.isFinite(value)) {
    throw new Error(`${spec.name} must be a finite number, received "${rawValue}"`);
  }
  const problem = spec.validate?.(value);
  if (problem !== undefined) {
    throw new Error(`${spec.name} ${problem}`);
  }
  return value;
}

export function readBoolean(spec: KindSpecWithDefault<'boolean', boolean>): boolean;
export function readBoolean(spec: KindSpec<'boolean', boolean>): boolean | undefined;
export function readBoolean(spec: KindSpec<'boolean', boolean>): boolean | undefined {
  const rawValue = readPresent(spec);
  if (rawValue === undefined) {
    return spec.default;
  }
  if (rawValue === 'true') {
    return true;
  }
  if (rawValue === 'false') {
    return false;
  }
  throw new Error(`${spec.name} must be "true" or "false", received "${rawValue}"`);
}

export function readAddress(spec: KindSpecWithDefault<'address', string>): Address;
export function readAddress(spec: KindSpec<'address', string>): Address | undefined;
export function readAddress(spec: KindSpec<'address', string>): Address | undefined {
  const rawValue = readPresent(spec) ?? spec.default;
  return rawValue === undefined ? undefined : address(rawValue);
}

/** Separator-delimited addresses. An absent variable parses the default, and no default means an empty list. */
export function readAddressList(spec: KindSpec<'addressList', string>): Address[] {
  return parseAddressList(readPresent(spec) ?? spec.default ?? '');
}

/** The default of a `json` setting is JSON text, parsed on every read. */
export function readJson<T>(spec: KindSpecWithDefault<'json', string>): T;
export function readJson<T>(spec: KindSpec<'json', string>): T | undefined;
export function readJson<T>(spec: KindSpec<'json', string>): T | undefined {
  const rawValue = readPresent(spec) ?? spec.default;
  return rawValue === undefined ? undefined : (JSON.parse(rawValue) as T);
}

/** Map of key suffix to value for every variable that starts with the prefix of a `NAME_*` setting. */
export function readPrefix(spec: SettingSpec): Map<string, string> {
  const keyPrefix = settingPrefix(spec);
  return new Map(
    Object.keys(process.env)
      .filter((key) => key.startsWith(keyPrefix))
      .map((matchingKey) => [matchingKey.substring(keyPrefix.length), process.env[matchingKey]!])
  );
}

export function settingPrefix(spec: SettingSpec): string {
  if (!spec.name.endsWith('*')) {
    throw new Error(`${spec.name} is not a prefix setting; its name must end with *`);
  }
  return spec.name.slice(0, -1);
}

/** Drops a trailing `# comment`, then splits on whitespace and commas. */
export function parseAddressList(value: string): Address[] {
  return value
    .replace(/#.+$/, '')
    .split(/[\s,]+/)
    .filter((s) => s !== '')
    .map((m) => address(m.trim()));
}

// ---------------------------------------------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------------------------------------------

function groupsInOrder<T extends { group: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.group) ?? [];
    group.push(item);
    groups.set(item.group, group);
  }
  return groups;
}

/** Quotes a value that contains whitespace, `$`, `#` or a quote. Single quotes when the value holds `"`. */
function envValue(value: SettingDefault | undefined): string {
  const text = value === undefined ? '' : String(value);
  if (!/[\s$#"']/.test(text)) {
    return text;
  }
  return text.includes('"') ? `'${text}'` : `"${text}"`;
}

/**
 * Renders `.env.example`: the header, then one `## Group` section per group in declaration order. Each setting is
 * `# description` followed by its line:
 * - with a starter: `NAME=starter`, and the description ends with ` (default: <default>)` when the two differ;
 * - required: `NAME=value` with `example ?? default`;
 * - otherwise: `# NAME=value` with `default ?? example`.
 */
export function renderEnvExample(settings: readonly SettingSpec[], header: string): string {
  const sections = [...groupsInOrder(settings).entries()].map(([group, groupSettings]) => {
    const lines = [`## ${group}`];
    for (const setting of groupSettings) {
      if (setting.starter !== undefined) {
        const differs = setting.default !== undefined && setting.starter !== setting.default;
        const shownDefault = setting.default === '' ? 'empty' : String(setting.default);
        lines.push(`# ${setting.description}${differs ? ` (default: ${shownDefault})` : ''}`);
        lines.push(`${setting.name}=${envValue(setting.starter)}`);
        continue;
      }
      lines.push(`# ${setting.description}`);
      if (setting.required !== undefined) {
        lines.push(`${setting.name}=${envValue(setting.example ?? setting.default)}`);
      } else {
        lines.push(`# ${setting.name}=${envValue(setting.default ?? setting.example)}`);
      }
    }
    return lines.join('\n');
  });
  return `${header.trimEnd()}\n\n${sections.join('\n\n')}\n`;
}

/** Escapes `|` everywhere, and `<`, `>` and `*` outside code spans, so env names such as `RPC_READ_<n>` render. */
function cell(text: string): string {
  return text
    .replace(/\n/g, ' ')
    .split('`')
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\*/g, '\\*')
    )
    .join('`')
    .replace(/\|/g, '\\|');
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function settingDefaultCell(setting: SettingSpec): string {
  const value =
    setting.default === undefined ? '—' : setting.default === '' ? '(empty)' : `\`${String(setting.default)}\``;
  if (setting.required === true) {
    return setting.default === undefined ? 'required' : `${value} (required)`;
  }
  if (setting.required === 'production') {
    return `${value} (required in production)`;
  }
  return value;
}

/** One `**Group**` label and table per group, in declaration order. Columns: Setting, Default, Used by, Description. */
export function renderSettingsTable(settings: readonly SettingSpec[]): string {
  return [...groupsInOrder(settings).entries()]
    .map(([group, groupSettings]) => {
      const rows = groupSettings.map((setting) => [
        `\`${setting.name}\``,
        settingDefaultCell(setting),
        setting.usedBy.join(', '),
        setting.description,
      ]);
      return `**${group}**\n\n${table(['Setting', 'Default', 'Used by', 'Description'], rows)}`;
    })
    .join('\n\n');
}

function appliesTo(field: ConfigFieldSpec): string {
  return field.strategies === undefined || field.strategies.length === 0
    ? 'all'
    : field.strategies.map((strategy) => `\`${strategy}\``).join(', ');
}

function fieldDefault(field: ConfigFieldSpec): string {
  return field.default ?? '—';
}

export type ConfigFieldTableHeadings = {
  readonly entry: string;
  /** Heading of the fields settable on the entry or a vault object. */
  readonly both: string;
  readonly vault: string;
};

/**
 * Two tables: entry fields (level `entry` or `both`) and vault-object fields (level `vault` or `both`),
 * each after its heading line.
 */
export function renderConfigFieldTables(
  fields: readonly ConfigFieldSpec[],
  headings: ConfigFieldTableHeadings = {
    entry: '**Entry fields**',
    both: '**Entry or vault-object fields**',
    vault: '**Vault-object fields**',
  }
): string {
  const rowsAt = (level: ConfigFieldSpec['level']) => fields.filter((field) => field.level === level);
  const entryRows = (level: ConfigFieldSpec['level']) =>
    rowsAt(level).map((field) => [
      `\`${field.name}\``,
      field.required ? 'yes' : 'no',
      fieldDefault(field),
      appliesTo(field),
      field.description,
    ]);
  const vaultRows = rowsAt('vault').map((field) => [
    `\`${field.name}\``,
    fieldDefault(field),
    appliesTo(field),
    field.description,
  ]);
  return [
    headings.entry,
    table(['Field', 'Required', 'Default', 'Applies to', 'Meaning'], entryRows('entry')),
    headings.both,
    table(['Field', 'Required', 'Default', 'Applies to', 'Meaning'], entryRows('both')),
    headings.vault,
    table(['Field', 'Default', 'Applies to', 'Meaning'], vaultRows),
  ].join('\n\n');
}

/** One row per strategy: its name and what it does. */
export function renderStrategiesTable(strategies: readonly { name: string; description: string }[]): string {
  return table(
    ['Strategy', 'What it does'],
    strategies.map((strategy) => [`\`${strategy.name}\``, strategy.description])
  );
}

/** Replaces the text between the two marker lines with `body`, keeping the markers. */
export function replaceBetweenMarkers(text: string, startMarker: string, endMarker: string, body: string): string {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Marker ${startMarker} not found`);
  }
  const bodyStart = start + startMarker.length;
  const end = text.indexOf(endMarker, bodyStart);
  if (end === -1) {
    throw new Error(`Marker ${endMarker} not found after ${startMarker}`);
  }
  return `${text.slice(0, bodyStart)}\n${body.trim()}\n${text.slice(end)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------------------------------------------

const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'tests', 'tests-localnet']);
// loadKeypairSigner reads its path setting with readPath.
const READER_NAMES =
  'readString|readNumber|readBoolean|readAddress|readAddressList|readUrl|readPath|readJson|readPrefix|loadKeypairSigner';
const SETTINGS_REF = `SETTINGS(?:\\.([A-Z][A-Z0-9_]*)|\\[\\s*['"]([A-Z][A-Z0-9_]*\\*?)['"]\\s*\\])`;
type ScanPattern = { regex: RegExp; toName: (match: RegExpExecArray) => string };
const READ_PATTERNS: readonly ScanPattern[] = [
  { regex: /\bgetEnv[A-Za-z]*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g, toName: (m) => m[1] },
  { regex: /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g, toName: (m) => m[1] },
  { regex: /\bprocess\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g, toName: (m) => m[1] },
  { regex: /\bgetAllEnvsByPrefix\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g, toName: (m) => `${m[1]}*` },
  {
    regex: new RegExp(`\\b(?:${READER_NAMES})(?:<(?:[^<>()]|<[^<>()]*>)*>)?\\(\\s*${SETTINGS_REF}`, 'g'),
    toName: (m) => m[1] ?? m[2],
  },
  { regex: new RegExp(`${SETTINGS_REF}\\.name\\b`, 'g'), toName: (m) => m[1] ?? m[2] },
];
/** A string, number or boolean literal. An identifier or member expression such as `SETTINGS.X.default` is not. */
const LITERAL = `(?:'(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|-?\\d[\\d_]*(?:\\.\\d+)?(?![\\w.])|(?:true|false)\\b)`;
const INLINE_DEFAULT_PATTERNS: readonly ScanPattern[] = [
  {
    regex: new RegExp(`\\bgetEnv[A-Za-z]*\\(\\s*['"]([A-Z][A-Z0-9_]*)['"]\\s*,\\s*${LITERAL}`, 'g'),
    toName: (m) => m[1],
  },
  {
    regex: new RegExp(`\\bprocess\\.env\\.([A-Z][A-Z0-9_]*)\\s*(?:\\|\\||\\?\\?)\\s*${LITERAL}`, 'g'),
    toName: (m) => m[1],
  },
  {
    regex: new RegExp(
      `\\bprocess\\.env\\[\\s*['"]([A-Z][A-Z0-9_]*)['"]\\s*\\]\\s*(?:\\|\\||\\?\\?)\\s*${LITERAL}`,
      'g'
    ),
    toName: (m) => m[1],
  },
];

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        files.push(...listTsFiles(entryPath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

/** Matches the patterns in `.ts` files under the given directories. Returns name to a `file:line` list. */
function scanSources(rootDirs: readonly string[], patterns: readonly ScanPattern[]): Map<string, string[]> {
  const reads = new Map<string, string[]>();
  for (const rootDir of rootDirs) {
    for (const file of listTsFiles(rootDir)) {
      const source = fs.readFileSync(file, 'utf8');
      const lineStarts = [0];
      for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') {
          lineStarts.push(i + 1);
        }
      }
      const found: { index: number; name: string }[] = [];
      for (const { regex, toName } of patterns) {
        regex.lastIndex = 0;
        for (let match = regex.exec(source); match !== null; match = regex.exec(source)) {
          found.push({ index: match.index, name: toName(match) });
        }
      }
      found.sort((a, b) => a.index - b.index);
      for (const { index, name } of found) {
        let line = 0;
        while (line + 1 < lineStarts.length && lineStarts[line + 1] <= index) {
          line++;
        }
        const location = `${file}:${line + 1}`;
        const locations = reads.get(name) ?? [];
        if (!locations.includes(location)) {
          locations.push(location);
        }
        reads.set(name, locations);
      }
    }
  }
  return reads;
}

/**
 * Finds environment reads in `.ts` files under the given directories, skipping build output and tests. Returns env
 * name to a `file:line` list, where `file` joins the given root dir and the relative path. A prefix read is
 * reported as `PREFIX_*`.
 */
export function scanEnvReads(rootDirs: readonly string[]): Map<string, string[]> {
  return scanSources(rootDirs, READ_PATTERNS);
}

/**
 * Finds reads that carry an inline string, number or boolean default: a `getEnv*` helper call with a literal second
 * argument, or a `process.env` read (dot or bracket form) followed by `||` or `??` and a literal. Same files and result
 * shape as `scanEnvReads`.
 */
export function scanInlineDefaults(rootDirs: readonly string[]): Map<string, string[]> {
  return scanSources(rootDirs, INLINE_DEFAULT_PATTERNS);
}

export type CheckSettingsInput = {
  settings: readonly SettingSpec[];
  reads: ReadonlyMap<string, readonly string[]>;
  allowList: readonly string[];
  /** Output of `scanInlineDefaults`, with the same path form as `reads`. */
  inlineDefaults?: ReadonlyMap<string, readonly string[]>;
  /** Files, or directories ending in `/`, whose inline defaults are allowed. */
  inlineDefaultAllowedPaths?: readonly string[];
};

function isAllowedPath(location: string, allowedPaths: readonly string[]): boolean {
  const file = location.slice(0, location.lastIndexOf(':'));
  return allowedPaths.some((allowed) => (allowed.endsWith('/') ? file.startsWith(allowed) : file === allowed));
}

/** Compares the declarations with the scanned reads. Returns one message per problem, sorted by name per kind. */
export function checkSettings({
  settings,
  reads,
  allowList,
  inlineDefaults = new Map(),
  inlineDefaultAllowedPaths = [],
}: CheckSettingsInput): string[] {
  const declared = new Set(settings.map((setting) => setting.name));
  const allowed = new Set(allowList);
  const problems: string[] = [];
  for (const [name, locations] of [...reads.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (declared.has(name) || allowed.has(name)) {
      continue;
    }
    if (name.endsWith('*')) {
      problems.push(`${name} is read by prefix at ${locations.join(', ')} but no setting named ${name} is declared`);
    } else {
      problems.push(`${name} is read at ${locations.join(', ')} but has no setting declaration`);
    }
  }
  for (const setting of settings) {
    if (!reads.has(setting.name)) {
      problems.push(`${setting.name} is declared but no code reads it`);
    }
  }
  for (const [name, locations] of [...inlineDefaults.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const location of locations) {
      if (!isAllowedPath(location, inlineDefaultAllowedPaths)) {
        problems.push(`${name} has an inline default at ${location}; use the registry default`);
      }
    }
  }
  return problems;
}
