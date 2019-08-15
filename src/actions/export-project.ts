import dedent from 'dedent/macro';
import { loadProject, fetchDependencies } from '../project';
import { exportTarget } from '../targets';
import { exportTo } from '../addin';
import { join, sanitize } from '../utils/path';
import { emptyDir, ensureDir, remove } from '../utils/fs';
import { CliError, ErrorCode } from '../errors';
import env from '../env';
import { Message } from '../messages';
import { Target, TargetType } from '../manifest/target';

export interface ExportOptions {
  target?: string;
  completed?: string;
  addin?: string;
}

export default async function exportProject(options: ExportOptions = {}) {
  env.reporter.log(Message.ExportProjectLoading, `[1/3] Loading project...`);

  const project = await loadProject();

  if (!options.target && !project.manifest.target) {
    throw new CliError(
      ErrorCode.ExportNoTarget,
      dedent`
        No default target found for project,
        use --target TYPE to export from a specific target.
      `
    );
  }

  let target: Target | undefined;
  if (project.manifest.target) {
    if (!options.target || options.target === project.manifest.target.type) {
      target = project.manifest.target;
    }
  } else {
    const type = <TargetType>options.target;
    const name = project.manifest.name;

    target = {
      type,
      name,
      path: `targets/${type}`,
      filename: `${sanitize(name)}.${type}`,
      blank: true
    };
  }

  if (!target) {
    throw new CliError(
      ErrorCode.ExportNoMatching,
      `No matching target found for type "${options.target!}" in project.`
    );
  }

  const dependencies = await fetchDependencies(project);
  let staging: string;

  try {
    if (!options.completed) {
      staging = join(project.paths.staging, 'export');

      env.reporter.log(Message.ExportToStaging, `\n[2/3] Exporting src from "${target.filename}"`);

      await ensureDir(staging);
      await emptyDir(staging);
      await exportTo(project, target, staging, options);
    } else {
      staging = options.completed;
    }

    env.reporter.log(Message.ExportToProject, `\n[3/3] Updating project`);
    await exportTarget(target, { project, dependencies }, staging);
  } catch (err) {
    throw err;
  } finally {
    // @ts-ignore Variable is used before being assigned
    if (staging) await remove(staging);
  }
}
