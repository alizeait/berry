import {BaseCommand, WorkspaceRequiredError}     from '@yarnpkg/cli';
import {Configuration, Project}                  from '@yarnpkg/core';
import {scriptUtils, structUtils}                from '@yarnpkg/core';
import {NativePath, Filename, ppath, xfs, npath} from '@yarnpkg/fslib';
import {Command, Option, Usage}                  from 'clipanion';

// eslint-disable-next-line arca/no-default-export
export default class DlxCommand extends BaseCommand {
  static paths = [
    [`dlx`],
  ];

  static usage: Usage = Command.Usage({
    description: `run a package in a temporary environment`,
    details: `
      This command will install a package within a temporary environment, and run its binary script if it contains any. The binary will run within the current cwd.

      By default Yarn will download the package named \`command\`, but this can be changed through the use of the \`-p,--package\` flag which will instruct Yarn to still run the same command but from a different package.

      Using \`yarn dlx\` as a replacement of \`yarn add\` isn't recommended, as it makes your project non-deterministic (Yarn doesn't keep track of the packages installed through \`dlx\` - neither their name, nor their version).
    `,
    examples: [[
      `Use create-react-app to create a new React app`,
      `yarn dlx create-react-app ./my-app`,
    ]],
  });

  pkg = Option.String(`-p,--package`, {
    description: `The package to run the provided command from`,
  });

  quiet = Option.Boolean(`-q,--quiet`, false, {
    description: `Only report critical errors instead of printing the full install logs`,
  });

  command = Option.String();
  args = Option.Proxy();

  async execute() {
    // Disable telemetry to prevent each `dlx` call from counting as a project
    Configuration.telemetry = null;

    return await xfs.mktempPromise(async baseDir => {
      const tmpDir = ppath.join(baseDir, `dlx-${process.pid}` as Filename);
      await xfs.mkdirPromise(tmpDir);

      await xfs.writeFilePromise(ppath.join(tmpDir, `package.json` as Filename), `{}\n`);
      await xfs.writeFilePromise(ppath.join(tmpDir, `yarn.lock` as Filename), ``);

      const targetYarnrc = ppath.join(tmpDir, `.yarnrc.yml` as Filename);
      const projectCwd = await Configuration.findProjectCwd(this.context.cwd, Filename.lockfile);

      const sourceYarnrc = projectCwd !== null
        ? ppath.join(projectCwd, `.yarnrc.yml` as Filename)
        : null;

      if (sourceYarnrc !== null && xfs.existsSync(sourceYarnrc)) {
        await xfs.copyFilePromise(sourceYarnrc, targetYarnrc);

        await Configuration.updateConfiguration(tmpDir, current => {
          const nextConfiguration: {[key: string]: unknown} = {
            ...current,
            enableGlobalCache: true,
            enableTelemetry: false,
          };

          if (Array.isArray(current.plugins)) {
            nextConfiguration.plugins = current.plugins.map((plugin: any) => {
              const sourcePath: NativePath = typeof plugin === `string`
                ? plugin
                : plugin.path;

              const remapPath = npath.isAbsolute(sourcePath)
                ? sourcePath
                : npath.resolve(npath.fromPortablePath(projectCwd!), sourcePath);

              if (typeof plugin === `string`) {
                return remapPath;
              } else {
                return {path: remapPath, spec: plugin.spec};
              }
            });
          }

          return nextConfiguration;
        });
      } else {
        await xfs.writeFilePromise(targetYarnrc, `enableGlobalCache: true\nenableTelemetry: false\n`);
      }

      const pkgs = typeof this.pkg !== `undefined`
        ? [this.pkg]
        : [this.command];

      const command = structUtils.parseDescriptor(this.command).name;

      const addExitCode = await this.cli.run([`add`, `--`, ...pkgs], {cwd: tmpDir, quiet: this.quiet});
      if (addExitCode !== 0)
        return addExitCode;

      if (!this.quiet)
        this.context.stdout.write(`\n`);

      const configuration = await Configuration.find(tmpDir, this.context.plugins);
      const {project, workspace} = await Project.find(configuration, tmpDir);

      if (workspace === null)
        throw new WorkspaceRequiredError(project.cwd, tmpDir);

      await project.restoreInstallState();

      return await scriptUtils.executeWorkspaceAccessibleBinary(workspace, command, this.args, {
        cwd: this.context.cwd,
        stdin: this.context.stdin,
        stdout: this.context.stdout,
        stderr: this.context.stderr,
      });
    });
  }
}
