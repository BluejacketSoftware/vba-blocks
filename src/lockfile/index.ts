import { ok } from 'assert';
import { satisfies as satisfiesSemver } from 'semver';
import { join, relative, trailing } from '../utils/path';
import { pathExists, readFile, writeFile } from '../utils/fs';
import { toLockfile as convertToToml, parse as parseToml } from '../utils/toml';
import has from '../utils/has';
import env from '../env';
import { loadManifest } from '../manifest';
import { isRegistryDependency, isPathDependency, isGitDependency } from '../manifest/dependency';
import {
  getRegistrationId,
  getRegistrationSource,
  getSourceParts,
  toDependency
} from '../sources/registration';
import { getRegistration } from '../resolve';
import { CliError, ErrorCode } from '../errors';
import { version } from '../../package.json';
import { Dependency } from '../manifest/dependency';
import { Workspace } from '../professional/workspace';
import { Registration } from '../sources/registration';
import { DependencyGraph } from '../resolve/dependency-graph';
import { Snapshot } from '../manifest';

export interface Lockfile {
  metadata?: { version: string };
  workspace: {
    root: Snapshot;
    members: Snapshot[];
  };
  packages: DependencyGraph;
}

const debug = env.debug('vba-blocks:lockfile');
const VBA_BLOCKS_VERSION = version;
const LOCKFILE_VERSION = '1';

type DependencyByName = Map<string, Dependency>;

/**
 * Read lockfile at given dir (if present)
 * (for invalid lockfile, errors are ignored and treated as no lockfile)
 */
export async function readLockfile(dir: string): Promise<Lockfile | null> {
  try {
    const file = join(dir, 'vba-block.lock');
    if (!(await pathExists(file))) return null;

    const toml = await readFile(file, 'utf8');
    return await fromToml(toml, dir);
  } catch (err) {
    debug('Error reading/parsing lockfile');
    debug(err);

    return null;
  }
}

/**
 * Write lockfile for project to given dir
 *
 * @throws lockfile-write-failed
 */
export async function writeLockfile(dir: string, lockfile: Lockfile): Promise<void> {
  const file = join(dir, 'vba-block.lock');
  debug(`Writing lockfile to ${file}`);

  try {
    const toml = toToml(lockfile, dir);
    await writeFile(file, toml);
  } catch (err) {
    throw new CliError(ErrorCode.LockfileWriteFailed, `Failed to write lockfile to "${file}".`);
  }
}

// Check if lockfile is still valid for loaded workspace
// (e.g. invalidated by changing/adding dependency to manifest)
export async function isLockfileValid(lockfile: Lockfile, workspace: Workspace): Promise<boolean> {
  if (!lockfile.metadata || lockfile.metadata.version !== LOCKFILE_VERSION) return false;

  if (!(await compareManifests(workspace.root, lockfile.workspace.root))) return false;

  if (lockfile.workspace.members.length !== workspace.members.length) return false;

  const byName: { [name: string]: Snapshot } = {};
  workspace.members.forEach(member => (byName[member.name] = member));

  for (const member of lockfile.workspace.members) {
    const currentMember = byName[member.name];
    if (!currentMember) return false;
    if (!(await compareManifests(currentMember, member))) return false;
  }

  return true;
}

// Convert lockfile/project to toml
// - toml, alphabetized and with trailing commas, should be suitable for VCS
export function toToml(lockfile: Lockfile, dir: string): string {
  const root = prepareManifest(lockfile.workspace.root, lockfile.packages, dir);
  const members: any[] = lockfile.workspace.members.map((member: Snapshot) =>
    prepareManifest(member, lockfile.packages, dir)
  );

  const packages: any[] = lockfile.packages
    .sort((a, b) => {
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    })
    .map((registration: Registration) => {
      const { name, version, source } = registration;
      const dependencies = registration.dependencies.map(dependency =>
        toDependencyId(dependency, lockfile.packages, dir)
      );

      return {
        name,
        version,
        source: prepareSource(source, dir),
        dependencies
      };
    });

  const metadata = { version: LOCKFILE_VERSION };
  const toml = convertToToml({ metadata, root, members, packages });

  return `# Auto-generated by vba-blocks ${VBA_BLOCKS_VERSION}\n${toml}`;
}

// Load lockfile from toml (including "hydrating" dependencies from packages)
export async function fromToml(toml: string, dir: string): Promise<Lockfile> {
  const parsed = await parseToml(toml);
  ok(has(parsed, 'root'), 'vba-block.lock is missing [root] field');

  const metadata = parsed.metadata;

  // First pass through packages to load high-level information
  // (needed to map dependencies to parsed packages)
  const byName: DependencyByName = new Map();
  const packages = (parsed.packages || []).map((value: any) => {
    const { name, version, source, dependencies } = value;
    ok(name && version && source && Array.isArray(dependencies), 'Invalid package in lockfile');

    const registration = {
      id: getRegistrationId(name, version),
      name,
      version,
      source: getSource(source, dir),
      dependencies
    };

    byName.set(name, toDependency(registration));

    return registration;
  });

  // Hydrate dependencies of packages
  packages.forEach((registration: any) => {
    registration.dependencies = registration.dependencies.map((id: string) =>
      getDependency(id, byName)
    );
  });

  // Load manifests for workspace
  const root = toManifest(parsed.root, byName);
  const members: Snapshot[] = (parsed.members || []).map((member: any) =>
    toManifest(member, byName)
  );

  return { metadata, workspace: { root, members }, packages };
}

// Convert raw toml value to manifest
function toManifest(value: any, byName: DependencyByName): Snapshot {
  const { name, version } = value;
  ok(name && version && Array.isArray(value.dependencies), 'Invalid manifest in lockfile');

  const dependencies: Dependency[] = value.dependencies.map((id: string) =>
    getDependency(id, byName)
  );

  return {
    name,
    version,
    dependencies
  };
}

// Prepare manifest for toml
function prepareManifest(manifest: Snapshot, packages: DependencyGraph, dir: string): any {
  const { name, version } = manifest;
  const dependencies = manifest.dependencies.map(dependency =>
    toDependencyId(dependency, packages, dir)
  );

  return {
    name,
    version,
    dependencies
  };
}

// Prepare registration source for toml
// (Convert full path to relative to root dir)
function prepareSource(source: string, dir: string): string {
  const { type, value, details } = getSourceParts(source);
  if (type !== 'path') return source;

  const relativePath = trailing(relative(dir, value));
  return getRegistrationSource(type, relativePath, details);
}

// "Hydrate" registration source from toml
// (Convert relative paths to absolute)
function getSource(source: string, dir: string): string {
  const { type, value, details } = getSourceParts(source);
  if (type !== 'path') return source;

  const absolutePath = join(dir, value);
  return getRegistrationSource(type, absolutePath, details);
}

// Get dependency id
//
// Minimum information needed for lockfile:
// "{name} {version} {source}"
function toDependencyId(dependency: Dependency, packages: DependencyGraph, dir: string) {
  const registration = getRegistration(packages, dependency);
  ok(registration, 'No package found for dependency');

  let { version, source } = registration!;
  const { type, value, details } = getSourceParts(source);

  if (type === 'path') {
    const relativePath = trailing(relative(dir, value));
    source = getRegistrationSource(type, relativePath, details);
  }

  return `${dependency.name} ${version} ${source}`;
}

// Get dependency by id (using name from id)
function getDependency(id: string, byName: DependencyByName): Dependency {
  const [name] = id.split(' ', 1);
  const dependency = byName.get(name);

  ok(dependency, `Package not found in lockfile, "${id}"`);

  return dependency!;
}

/**
 * Compare features between current user manifest and lockfile manifest
 *
 * - name
 * - version
 * - dependencies
 */
async function compareManifests(current: Snapshot, locked: Snapshot): Promise<boolean> {
  if (current.name !== locked.name) return false;
  if (current.version !== locked.version) return false;

  return await compareDependencies(current, locked);
}

// Compare dependencies between current user manifest and lockfile manifest
async function compareDependencies(current: Snapshot, locked: Snapshot): Promise<boolean> {
  if (current.dependencies.length !== locked.dependencies.length) return false;

  const byName: { [name: string]: Dependency } = {};
  current.dependencies.forEach(dependency => (byName[dependency.name] = dependency));

  for (const dependency of locked.dependencies) {
    const currentValue = byName[dependency.name];
    if (!currentValue) return false;
    if (!(await satisfiesDependency(currentValue, dependency))) return false;
  }

  return true;
}

async function satisfiesDependency(value: Dependency, comparison: Dependency): Promise<boolean> {
  if (isRegistryDependency(comparison)) {
    // Note: Order matters in value / comparison
    //
    // value = manifest / user value
    // comparison = lockfile value (more specific)
    return isRegistryDependency(value) && satisfiesSemver(comparison.version, value.version);
  } else if (isPathDependency(comparison)) {
    if (!isPathDependency(value)) return false;
    if (value.path !== comparison.path) return false;

    // Check if current version of path dependency matches
    const manifest = await loadManifest(value.path);
    return manifest.version === comparison.version!;
  } else if (isGitDependency(comparison)) {
    if (!isGitDependency(value)) return false;

    if (has(value, 'rev') && has(comparison, 'rev')) return value.rev === comparison.rev;
    if (has(value, 'tag') && has(comparison, 'tag')) return value.tag === comparison.tag;
    if (has(value, 'branch') && has(comparison, 'branch'))
      return value.branch === comparison.branch;
  }

  return false;
}
