import { Ecosystem, ProjectInfo, ProjectType } from './types';

/**
 * Detect the project type from the checked-out tree's file list.
 * v1 runs live builds for node; python/go/rust fall back to the README +
 * install snippet + tests path.
 */
export function detectProject(files: string[]): ProjectInfo {
  const set = new Set(files);
  const readmePath = files.find((f) => /^readme(\.md|\.markdown|\.rst)?$|^readme\.txt$/i.test(f));
  let type: ProjectType = 'unknown';
  let ecosystem: Ecosystem = 'unknown';
  if (set.has('package.json')) {
    type = 'node';
    ecosystem = 'npm';
  } else if (set.has('requirements.txt') || set.has('pyproject.toml') || set.has('setup.py')) {
    type = 'python';
    ecosystem = 'pypi';
  } else if (set.has('go.mod')) {
    type = 'go';
    ecosystem = 'go';
  } else if (set.has('Cargo.toml')) {
    type = 'rust';
    ecosystem = 'cargo';
  }
  return { type, ecosystem, files, readmePath };
}
