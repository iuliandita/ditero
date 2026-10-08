#!/usr/bin/env python3
"""Check cumulative release documentation from an immutable review epoch, offline."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys

# Conservative superset of each later release range. Moving this epoch requires
# a reviewed policy migration; a caller cannot reset it with a range argument.
BASE = 'c35671cb3b5a8c6eba960c097510c2c61d5aa2fd'
TAG = 'v0.0.1-alpha.10'
TAG_OBJECT = '5643648d9d63946723663a985488180f76749b74'


def git(root, *args):
    return subprocess.check_output(
        ['git', '--no-pager', *args], cwd=root, text=True, timeout=30,
        env={**os.environ, 'GIT_CONFIG_NOSYSTEM': '1',
             'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_NO_REPLACE_OBJECTS': '1'}).strip()


def check(root, head, policy):
    if not re.fullmatch('[0-9a-f]{40}', head):
        raise ValueError('Release documentation head must be an immutable commit SHA')
    if git(root, 'cat-file', '-t', head) != 'commit':
        raise ValueError('Release documentation head must be a commit')
    if (git(root, 'rev-parse', f'refs/tags/{TAG}') != TAG_OBJECT or
            git(root, 'rev-parse', f'refs/tags/{TAG}^{{commit}}') != BASE):
        raise ValueError('Release documentation epoch tag is missing or changed')
    git(root, 'merge-base', '--is-ancestor', BASE, head)
    if policy.is_symlink() or not policy.is_file():
        raise ValueError('Documentation policy must be a regular file')
    subprocess.run([sys.executable, '-I', str(policy), '--base', BASE, '--head', head],
                   cwd=root, check=True, timeout=180)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--head')
    parser.add_argument('--policy', type=Path,
                        default=Path(__file__).with_name('docs-impact.py'))
    args = parser.parse_args()
    root = Path.cwd()
    check(root, args.head or git(root, 'rev-parse', 'HEAD'), args.policy.resolve()
          if not args.policy.is_symlink() else args.policy)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Release documentation check failed: ' + ascii(str(error)), file=sys.stderr)
        sys.exit(1)
