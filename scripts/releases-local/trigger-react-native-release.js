/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 * @oncall react_native
 */

'use strict';

const {REPO_ROOT} = require('../consts');
const detectPackageUnreleasedChanges = require('../monorepo/bump-all-updated-packages/bump-utils.js');
const checkForGitChanges = require('../monorepo/check-for-git-changes');
const {failIfTagExists} = require('../releases/utils/release-utils');
const {
  isReleaseBranch,
  parseVersion,
} = require('../releases/utils/version-utils');
const {exitIfNotOnGit, getBranchName} = require('../scm-utils');
const {getPackages} = require('../utils/monorepo');
const chalk = require('chalk');
const inquirer = require('inquirer');
const path = require('path');
const request = require('request');
const {echo, exit} = require('shelljs');
const yargs = require('yargs');

/**
 * This script walks a releaser through bumping the version for a release
 * It will commit the appropriate tags to trigger the CircleCI jobs.
 */

let argv = yargs
  .option('r', {
    alias: 'remote',
    default: 'origin',
  })
  .option('t', {
    alias: 'token',
    describe:
      'Your CircleCI personal API token. See https://circleci.com/docs/2.0/managing-api-tokens/#creating-a-personal-api-token to set one',
    required: true,
  })
  .option('v', {
    alias: 'to-version',
    describe: 'Version you aim to release, ex. 0.67.0-rc.1, 0.66.3',
    required: true,
  })
  .check(() => {
    const branch = exitIfNotOnGit(
      () => getBranchName(),
      "Not in git. You can't invoke trigger-react-native-release from outside a git repo.",
    );
    exitIfNotOnReleaseBranch(branch);
    return true;
  }).argv;

function exitIfNotOnReleaseBranch(branch /*: string */) {
  if (!isReleaseBranch(branch)) {
    console.log(
      'This script must be run in a react-native git repository checkout and on a release branch',
    );
    exit(1);
  }
}

const buildExecutor =
  (
    packageAbsolutePath /*: string */,
    packageRelativePathFromRoot /*: string */,
    packageManifest /*: $FlowFixMe */,
  ) =>
  async () => {
    const {name: packageName} = packageManifest;
    if (packageManifest.private) {
      return;
    }

    if (
      detectPackageUnreleasedChanges(
        packageRelativePathFromRoot,
        packageName,
        REPO_ROOT,
      )
    ) {
      // if I enter here, I want to throw an error upward
      throw new Error(
        `Package ${packageName} has unreleased changes. Please release it first.`,
      );
    }
  };

async function exitIfUnreleasedPackages() {
  // use the other script to verify that there's no packages in the monorepo
  // that have changes that haven't been released

  const packages = await getPackages({
    includeReactNative: false,
    includePrivate: true,
  });

  for (const pkg of Object.values(packages)) {
    const executor = buildExecutor(
      pkg.path,
      path.relative(REPO_ROOT, pkg.path),
      pkg.packageJson,
    );

    await executor().catch(error => {
      echo(chalk.red(error));
      // need to throw upward
      throw error;
    });
  }
}

function triggerReleaseWorkflow(options /*: $FlowFixMe */) {
  return new Promise((resolve, reject) => {
    request(options, function (error, response, body) {
      if (error) {
        reject(error);
      } else {
        resolve(body);
      }
    });
  });
}

async function main() {
  const branch = exitIfNotOnGit(
    () => getBranchName(),
    "Not in git. You can't invoke trigger-react-native-release from outside a git repo.",
  );

  // check for uncommitted changes
  if (checkForGitChanges()) {
    echo(
      chalk.red(
        'Found uncommitted changes. Please commit or stash them before running this script',
      ),
    );
    exit(1);
  }

  // now check for unreleased packages
  try {
    await exitIfUnreleasedPackages();
  } catch (error) {
    exit(1);
  }

  // $FlowFixMe[prop-missing]
  const token = argv.token;
  // $FlowFixMe[prop-missing]
  const releaseVersion = argv.toVersion;
  failIfTagExists(releaseVersion, 'release');

  const {pushed} = await inquirer.prompt({
    type: 'confirm',
    name: 'pushed',
    message: `This script will trigger a release with whatever changes are on the remote branch: ${branch}. \nMake sure you have pushed any updates remotely.`,
  });

  if (!pushed) {
    // $FlowFixMe[prop-missing]
    console.log(`Please run 'git push ${argv.remote} ${branch}'`);
    exit(1);
    return;
  }

  let latest = false;
  const {version, prerelease} = parseVersion(releaseVersion, 'release');
  if (!prerelease) {
    const {setLatest} = await inquirer.prompt({
      type: 'confirm',
      name: 'setLatest',
      message: `Do you want to set ${version} as "latest" release on npm?`,
    });
    latest = setLatest;
  }

  const npmTag = latest ? 'latest' : !prerelease ? branch : 'next';
  const {confirmRelease} = await inquirer.prompt({
    type: 'confirm',
    name: 'confirmRelease',
    message: `Releasing version "${version}" with npm tag "${npmTag}". Is this correct?`,
  });

  if (!confirmRelease) {
    console.log('Aborting.');
    return;
  }

  const parameters = {
    release_version: version,
    release_latest: latest,
    run_release_workflow: true,
  };

  const options = {
    method: 'POST',
    url: 'https://circleci.com/api/v2/project/github/facebook/react-native/pipeline',
    headers: {
      'Circle-Token': token,
      'content-type': 'application/json',
    },
    body: {
      branch,
      parameters,
    },
    json: true,
  };

  // See response: https://circleci.com/docs/api/v2/#operation/triggerPipeline
  const body = await triggerReleaseWorkflow(options);
  console.log(
    // $FlowFixMe[incompatible-use]
    `Monitor your release workflow: https://app.circleci.com/pipelines/github/facebook/react-native/${body.number}`,
  );

  // TODO
  // - Output the release changelog to paste into Github releases
  // - Link to release discussions to update
  // - Verify RN-diff publish is through
}

// $FlowFixMe[unused-promise]
main().then(() => {
  exit(0);
});
