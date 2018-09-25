import env from '../env';
import { Project } from '../project';
import { Changeset } from './compare-build-graphs';
import { Component } from './component';
import { Source } from '../manifest';
import { writeFile, remove, ensureDir } from '../utils/fs';
import { join, dirname } from '../utils/path';
import parallel from '../utils/parallel';
import {
  addSource,
  removeSource,
  applyChanges
} from '../manifest/patch-manifest';

export default async function applyChangeset(
  project: Project,
  changeset: Changeset
) {
  // Update src directory
  await parallel(
    changeset.components.changed,
    component => writeComponent(component.details.path!, component),
    { progress: env.reporter.progress('Updating src') }
  );

  await parallel(
    changeset.components.added,
    async component => {
      const path = join(project.paths.dir, 'src', component.filename);
      component.details.path = path;

      await writeComponent(path, component);
    },
    { progress: env.reporter.progress('Adding src') }
  );

  await parallel(
    changeset.components.removed,
    async component => {
      await remove(component.details.path!);
    },
    { progress: env.reporter.progress('Removing src') }
  );

  await updateManifest(project, changeset);
}

async function updateManifest(project: Project, changeset: Changeset) {
  const changes: string[] = [];
  for (const component of changeset.components.added) {
    const source: Source = {
      name: component.name,
      path: join(project.paths.dir, `src/${component.filename}`)
    };
    project.manifest.src.push(source);
    changes.push(addSource(project.manifest, source));
  }
  for (const component of changeset.components.removed) {
    const index = project.manifest.src.findIndex(
      source => source.name === component.name
    );
    project.manifest.src.splice(index, 1);
    changes.push(removeSource(project.manifest, component.name));
  }

  applyChanges(changes);
}

async function writeComponent(path: string, component: Component) {
  const dir = dirname(path);
  await ensureDir(dir);
  await writeFile(path, component.code);

  if (component.binary_path) {
    await writeFile(join(dir, component.binary_path), component.details.binary);
  }
}
