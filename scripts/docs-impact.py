#!/usr/bin/env python3
"""Bounded Git-blob documentation checks; no project imports or network access."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

DECLARATION = '.github/docs-impact.json'
SHA = re.compile(r'[0-9a-f]{40}')
LIMIT = 2 * 1024 * 1024
# Source prefixes and exact files, paired with permitted user-facing guides.
RULES = {
    'configuration': (('src/config/',), ('deploy/', 'docs/runbooks/', '.env.example')),
    'authentication': (('src/auth/', 'src/server/native-auth/'),
                       ('docs/runbooks/native-authentication.md', 'docs/runbooks/public-api.md',
                        'apps/android/README.md', 'apps/desktop/README.md')),
    'public-api': (('src/server/public-api/', 'src/domain/public-api'),
                   ('docs/runbooks/public-api.md', 'docs/cli.md', 'docs/mcp.md', 'docs/tui.md')),
    'clients': (('src/cli/', 'src/mcp/', 'src/tui/', 'scripts/build-clients.ts'),
                ('docs/cli.md', 'docs/mcp.md', 'docs/tui.md')),
    'native': (('apps/android/src/bridge.ts', 'apps/android/src/runtime.ts',
                'apps/android/src/attachment-runtime.ts',
                'apps/android/android/app/src/main/java/io/ditero/app/NativeSessionVault.java',
                'apps/android/android/app/src/main/java/io/ditero/app/NativeAttachmentTransfers.java',
                'apps/android/android/app/src/main/java/io/ditero/app/ServerContext.java',
                'apps/desktop/src-tauri/src/',
                'src/web/lib/e2e/runtime.ts', 'src/web/lib/e2e/attachment-migration-api.ts'),
               ('apps/android/README.md', 'apps/desktop/README.md',
                'docs/runbooks/native-authentication.md', 'docs/runbooks/native-format.md')),
    'deployment': (('deploy/', 'Dockerfile', 'Dockerfile.debian'),
                   ('deploy/', 'docs/runbooks/backup-restore.md', 'docs/runbooks/database-roles.md')),
    'release': (('release.json', 'scripts/release.py', '.github/workflows/release.yml',
                 '.github/workflows/native-release.yml', '.github/workflows/release-checks.yml'),
                ('RELEASING.md', 'README.md', 'docs/ROADMAP.md', 'deploy/')),
    'compatibility': (('drizzle/', 'src/db/migrate.ts', 'src/server/attachments/',
                       'src/domain/attachment', 'src/domain/e2e/envelope.ts', 'src/domain/e2e/stream.ts',
                       'src/web/lib/e2e/device-store.ts', 'src/server/storage/',
                       'src/domain/portability/attachment-archive.ts',
                       'src/web/lib/e2e/attachment-archive.ts',
                       'src/web/lib/e2e/attachment-migration-prepare.ts',
                       'patches/@rocicorp%2Fzero@', 'src/web/lib/zero-lifecycle.ts',
                       'src/web/lib/zero-runtime.ts', 'src/web/lib/zero-auth.ts'),
                      ('docs/runbooks/backup-restore.md', 'docs/runbooks/native-format.md',
                       'docs/runbooks/database-roles.md', 'apps/android/README.md',
                       'apps/desktop/README.md')),
}
TOPICS = ('upgrade', 'backup', 'rollback', 'clientVersions')
ENV = re.compile(r'(?:process|Bun)\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*[\"\']([A-Z][A-Z0-9_]*)[\"\']\s*\])|\b(DITERO_[A-Z0-9_]+)\b')


def git(root, *args):
    result = subprocess.run(['git', '--no-pager', *args], cwd=root,
                            capture_output=True, timeout=30, check=False,
                            env={**os.environ, 'GIT_CONFIG_NOSYSTEM': '1',
                                 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_NO_REPLACE_OBJECTS': '1'})
    if result.returncode:
        raise ValueError('Git object/range operation failed: ' + ascii(result.stderr[:500]))
    return result.stdout


def commit(root, value):
    if not SHA.fullmatch(value):
        raise ValueError('Expected a full lowercase 40-character commit SHA')
    if git(root, 'cat-file', '-t', value).strip() != b'commit':
        raise ValueError('Expected a commit object')
    return value


def tree(root, rev):
    entries = {}
    for row in git(root, 'ls-tree', '-r', '-z', rev).split(b'\0'):
        if row:
            info, name = row.split(b'\t', 1)
            mode, kind, oid = info.decode('ascii').split()
            entries[name.decode('utf-8', 'strict')] = (mode, kind, oid)
    return entries


def blob(root, entries, path):
    entry = entries.get(path)
    if entry is None:
        return ''
    if entry[0] not in ('100644', '100755') or entry[1] != 'blob':
        raise ValueError('Nonregular input: ' + ascii(path))
    size = int(git(root, 'cat-file', '-s', entry[2]))
    if size > LIMIT:
        raise ValueError('Input exceeds 2 MiB: ' + ascii(path))
    return git(root, 'cat-file', 'blob', entry[2]).decode('utf-8', 'strict')


def matches(path, patterns):
    return any(path.startswith(p) if p.endswith('/') or p.endswith('@') or
               p in ('src/domain/public-api', 'src/domain/attachment', 'src/web/lib/zero-retirement')
               else path == p for p in patterns)


def production(path):
    return not document(path) and not re.search(r'(?:^|/)(?:tests?|__tests__)/|\.(?:test|spec)\.', path)


def document(path):
    return path.endswith('.md') or path.endswith('.env.example')


def digest(entries, group):
    selected = [(p, v) for p, v in entries.items()
                if production(p) and matches(p, RULES[group][0])]
    return hashlib.sha256(json.dumps(sorted(selected), separators=(',', ':')).encode()).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key: ' + ascii(key))
        result[key] = value
    return result


def declarations(text):
    value = json.loads(text or '{"version":1,"groups":{}}', object_pairs_hook=unique)
    if not isinstance(value, dict) or set(value) != {'version', 'groups'} or type(value['version']) is not int or value['version'] != 1 or not isinstance(value['groups'], dict):
        raise ValueError('Invalid documentation-impact schema')
    for group, entry in value['groups'].items():
        if group not in RULES or not isinstance(entry, dict):
            raise ValueError('Unknown group or invalid entry')
        required = {'noImpact', 'sourceDigest'} | (set(TOPICS) if group == 'compatibility' else set())
        if set(entry) != required or not re.fullmatch(r'[0-9a-f]{64}', str(entry['sourceDigest'])):
            raise ValueError('Invalid rationale fields for ' + group)
        for key in required - {'sourceDigest'}:
            if not isinstance(entry[key], str) or not 30 <= len(entry[key].strip()) <= 2000:
                raise ValueError('Provide a specific 30-2000 character explanation for ' + key)
    return value['groups']



def canonical_markdown(path):
    # Operator/contributor guides only; historical changelog, tests, site, assets,
    # vendored notices and tool-generated/package documentation are separate.
    return (path in ('README.md', 'RELEASING.md', 'CONTRIBUTING.md', 'SECURITY.md') or
            (path.startswith('docs/') and not path.startswith('docs/local/') and path.endswith('.md')) or
            (path.startswith(('apps/', 'deploy/')) and path.endswith('/README.md')))


def literal_names(text):
    return {next(value for value in match if value) for match in ENV.findall(text)}


def local_links(root, entries, paths):
    errors = []
    for path in sorted(paths):
        text = blob(root, entries, path)
        # Ignore code examples; support inline and reference destinations, not anchors.
        text = re.sub(r'```.*?```|`[^`\n]*`', '', text, flags=re.S)
        links = re.findall(r'!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)', text)
        links += re.findall(r'^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)', text, flags=re.M)
        for raw in links:
            url = urlsplit(raw.strip('<>'))
            if url.scheme or url.netloc or not url.path:
                continue
            decoded = unquote(url.path)
            target = posixpath.normpath(decoded.lstrip('/') if decoded.startswith('/')
                                        else posixpath.join(posixpath.dirname(path), decoded))
            if target == '..' or target.startswith('../') or '\\' in target or '\x00' in target:
                errors.append('Link escapes Git tree: ' + ascii(path)); continue
            if target == '.':
                continue  # The repository tree root is a valid directory destination.
            entry = entries.get(target)
            if entry and entry[0] not in ('100644', '100755'):
                errors.append('Nonregular link target: ' + ascii(target))
            elif entry is None and not any(p.startswith(target.rstrip('/') + '/') for p in entries):
                errors.append('Missing local link: ' + ascii(path) + ' -> ' + ascii(target))
    return errors


def check(root, base, head, pr=False, static=False):
    head = commit(root, head)
    current = tree(root, head)
    if static:
        paths = {p for p in current if canonical_markdown(p)}
        errors = local_links(root, current, paths)
        for required in ('README.md', 'RELEASING.md'):
            if required not in current:
                errors.append('Missing canonical guide: ' + required)
        inventory_paths = {p for p in current if p.startswith('src/config/') and
                           p.endswith('.ts') and production(p) and
                           p != 'src/config/test-crash.ts'}
        names = set()
        for path in inventory_paths:
            names |= literal_names(blob(root, current, path))
        # Exclude explicit test seams and process mode; not operator settings.
        names = {name for name in names if name != 'NODE_ENV' and
                 not name.startswith(('DITERO_TEST_', 'E2E_'))}
        guidance_paths = paths | {p for p in current if p == '.env.example'}
        guidance = '\n'.join(blob(root, current, p) for p in sorted(guidance_paths))
        missing = sorted(name for name in names if name not in guidance)
        if missing:
            errors.append('Undocumented literal configuration names: ' + ascii(missing))
        return {'head': head, 'mode': 'static', 'markdownPaths': sorted(paths),
                'configurationSourcePaths': sorted(inventory_paths),
                'configurationNames': sorted(names), 'errors': errors}
    base = commit(root, base)
    start = git(root, 'merge-base', base, head).decode().strip() if pr else base
    previous = tree(root, start)
    changed = {p for p in previous.keys() | current.keys() if previous.get(p) != current.get(p)}
    groups = {g for g, (sources, _) in RULES.items()
              if any(production(p) and matches(p, sources) for p in changed)}
    now = declarations(blob(root, current, DECLARATION))
    before = declarations(blob(root, previous, DECLARATION))
    docs = {p for p in changed if p in current and document(p) and
            blob(root, previous, p).split() != blob(root, current, p).split()}
    errors = []
    for group in sorted(groups):
        relevant = {p for p in docs if matches(p, RULES[group][1])}
        if relevant:
            if group == 'compatibility':
                guidance = '\n'.join(blob(root, current, p) for p in relevant).lower()
                if any(cue not in guidance for cue in ('upgrade', 'backup', 'rollback', 'client')):
                    errors.append('Compatibility docs need upgrade, backup, rollback and client-version guidance')
            continue
        entry = now.get(group)
        if not entry or entry == before.get(group) or entry['sourceDigest'] != digest(current, group):
            errors.append(group + ': change relevant docs or provide a fresh source-bound no-impact explanation')
    for path in changed:
        if matches(path, RULES['configuration'][0]) and production(path):
            altered = literal_names(blob(root, previous, path)) ^ literal_names(blob(root, current, path))
            guidance = '\n'.join(blob(root, current, p) + blob(root, previous, p)
                                 for p in docs if matches(p, RULES['configuration'][1]))
            if altered and not all(name in guidance for name in altered):
                errors.append('Changed literal configuration names need changed guidance: ' + ascii(sorted(altered)))
    # Recheck inbound links when deleting a Markdown target.
    link_paths = {p for p in docs if p.endswith('.md')}
    if any(p.endswith('.md') and p not in current for p in changed):
        link_paths |= {p for p in current if p.endswith('.md')}
    errors += local_links(root, current, link_paths)
    return {'base': base, 'head': head, 'comparisonBase': start, 'groups': sorted(groups),
            'sourceDigests': {g: digest(current, g) for g in sorted(groups)}, 'errors': errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base')
    parser.add_argument('--head')
    parser.add_argument('--pr', action='store_true')
    parser.add_argument('--static', action='store_true')
    parser.add_argument('--event')
    args = parser.parse_args()
    root = Path.cwd()
    if args.event:
        if args.base or args.head or args.static or args.pr:
            raise ValueError('--event cannot be combined with range options')
        event_path = Path(args.event)
        if event_path.stat().st_size > LIMIT:
            raise ValueError('Event exceeds limit')
        event = json.loads(event_path.read_text(), object_pairs_hook=unique)
        pr = event.get('pull_request')
        if pr:
            args.base, args.head, args.pr = pr['base']['sha'], pr['head']['sha'], True
            checkout = git(root, 'rev-parse', 'HEAD').decode().strip()
            for value in (args.base, args.head):
                commit(root, value)
                git(root, 'merge-base', '--is-ancestor', value, checkout)
        else:
            args.base, args.head = event['before'], event['after']
            if args.head != git(root, 'rev-parse', 'HEAD').decode().strip():
                raise ValueError('Push head differs from checkout')
    if args.static and not args.head:
        args.head = git(root, 'rev-parse', 'HEAD').decode().strip()
    if not args.head or (not args.static and not args.base):
        parser.error('Provide --base and --head, --event, or --static')
    result = check(root, args.base, args.head, args.pr, args.static)
    result['checkerSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return bool(result['errors'])


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError, UnicodeError, subprocess.SubprocessError) as error:
        print('Documentation check failed: ' + ascii(str(error)), file=sys.stderr)
        sys.exit(1)
