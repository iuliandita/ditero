#!/usr/bin/env python3
"""Offline behavior and hostile-input fixtures; no project dependencies."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('docs_impact', Path(__file__).with_name('docs-impact.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class DocumentationImpact(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.write('src/cli/main.ts', 'export const version = 1\n')
        self.write('docs/cli.md', '# CLI\n')
        self.write('.github/docs-impact.json', '{"version":1,"groups":{}}\n')
        self.base = self.save()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.PIPE).decode().strip()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def save(self):
        self.git('add', '--all')
        self.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture')
        return self.git('rev-parse', 'HEAD')

    def check(self, base=None, pr=False):
        return guard.check(self.root, base or self.base, self.save(), pr)['errors']

    def rationale(self, group):
        head = self.save()
        entry = {'noImpact': 'Move internal helpers while preserving all documented behavior.',
                 'sourceDigest': guard.digest(guard.tree(self.root, head), group)}
        if group == 'compatibility':
            entry.update({key: 'No compatibility effect because only an internal name changes.' for key in guard.TOPICS})
        self.write('.github/docs-impact.json', json.dumps({'version': 1, 'groups': {group: entry}}))

    def documented(self, group, paths):
        self.git('add', '--all')
        head = self.save() if self.git('diff', '--cached', '--name-only') else self.git('rev-parse', 'HEAD')
        path = self.root / '.github/docs-impact.json'
        value = json.loads(path.read_text())
        entry = {'docs': paths, 'note': 'Updated the cited instructions for the current source behavior.',
                 'sourceDigest': guard.digest(guard.tree(self.root, head), group)}
        if group == 'compatibility':
            entry.update({key: 'The cited recovery guide explains the current compatibility requirements.' for key in guard.TOPICS})
        value['groups'][group] = entry
        path.write_text(json.dumps(value))

    def test_internal_and_test_only(self):
        self.write('src/cli/main.test.ts', 'throw new Error("inert")')
        self.write('src/web/internal.ts', 'export const helper = 1')
        self.assertEqual([], self.check())

    def test_missing_docs_and_unrelated_docs(self):
        self.write('src/cli/main.ts', 'export const version = 2')
        self.write('docs/unrelated.md', '# Unrelated')
        self.assertIn('clients:', self.check()[0])

    def test_relevant_docs_without_declaration(self):
        self.write('src/cli/main.ts', 'export const version = 2')
        self.write('docs/cli.md', '# CLI\nChanged command behavior.\n')
        self.documented('clients', ['docs/cli.md'])
        self.assertEqual([], self.check())

    def test_fresh_rationale_then_stale(self):
        self.write('src/cli/main.ts', 'export const version = 2')
        self.rationale('clients')
        self.assertEqual([], self.check())
        self.base = self.git('rev-parse', 'HEAD')
        self.write('src/cli/main.ts', 'export const version = 3')
        self.assertTrue(self.check())

    def test_compatibility_cues(self):
        self.write('drizzle/0001.sql', 'alter table tasks add column sample text;')
        self.write('docs/runbooks/backup-restore.md', '# Backup\nNew schema.\n')
        self.documented('compatibility', ['docs/runbooks/backup-restore.md'])
        self.assertIn('Compatibility docs', self.check()[0])

    def test_complete_compatibility_guidance(self):
        self.write('drizzle/0001.sql', 'alter table tasks add column sample text;')
        self.write('docs/runbooks/backup-restore.md', '# Upgrade\nBackup before upgrade. Rollback needs the previous backup. Client versions must match.\n')
        self.documented('compatibility', ['docs/runbooks/backup-restore.md'])
        self.assertEqual([], self.check())

    def test_configuration_literals(self):
        self.write('src/config/env.ts', 'const value = process.env.DITERO_SAMPLE')
        self.write('deploy/README.md', '# Configuration\nNew setting.\n')
        self.assertTrue(any('literal configuration' in e for e in self.check()))

    def test_configuration_guidance(self):
        self.write('src/config/env.ts', 'const value = process.env.DITERO_SAMPLE')
        self.write('deploy/README.md', '# Configuration\nDITERO_SAMPLE controls the sample setting.\n')
        self.documented('configuration', ['deploy/README.md'])
        self.assertEqual([], self.check())

    def test_local_link_and_external_link(self):
        self.write('docs/space name.md', '# Target')
        self.write('docs/cli.md', '[local](space%20name.md#unchecked) [external](https://example.invalid/no-fetch)')
        self.assertEqual([], self.check())

    def test_broken_link(self):
        self.write('docs/cli.md', '[missing](missing.md)')
        self.assertIn('Missing local link', self.check()[0])

    def test_deleted_target_inbound(self):
        self.write('docs/target.md', '# Target')
        self.write('docs/cli.md', '[target](target.md)')
        self.base = self.save()
        (self.root / 'docs/target.md').unlink()
        self.assertIn('Missing local link', self.check()[0])

    def test_symlink(self):
        (self.root / 'docs/link.md').symlink_to('/etc/passwd')
        self.write('docs/cli.md', '[unsafe](link.md)')
        with self.assertRaisesRegex(ValueError, 'Nonregular'):
            self.check()

    def test_hostile_names_and_hooks_inert(self):
        self.write('docs/--$(touch SENTINEL)\nspace.md', '# Data')
        self.write('package.json', '{"scripts":{"preinstall":"touch SENTINEL"}}')
        self.write('src/cli/main.test.ts', 'require("fs").writeFileSync("SENTINEL", "bad")')
        self.assertEqual([], self.check())
        self.assertFalse((self.root / 'SENTINEL').exists())

    def test_invalid_commit(self):
        with self.assertRaises(ValueError):
            guard.check(self.root, '--help; touch SENTINEL', self.base)
        self.assertFalse((self.root / 'SENTINEL').exists())

    def test_duplicate_and_unknown_declaration(self):
        for text in ('{"version":1,"version":1,"groups":{}}',
                     '{"version":1,"groups":{"unknown":{}}}'):
            with self.assertRaises(ValueError):
                guard.declarations(text)

    def test_source_digest_cannot_be_forged(self):
        self.write('src/cli/main.ts', 'export const version = 2')
        self.rationale('clients')
        path = self.root / '.github/docs-impact.json'
        value = json.loads(path.read_text())
        value['groups']['clients']['sourceDigest'] = '0' * 64
        path.write_text(json.dumps(value))
        self.assertTrue(self.check())

    def test_whitespace_only_docs_do_not_qualify(self):
        self.write('src/cli/main.ts', 'export const version = 2')
        self.write('docs/cli.md', '# CLI\n\n   \n')
        self.assertTrue(self.check())

    def test_push_event_head_mismatch(self):
        self.write('unrelated.txt', 'Changed')
        self.save()
        event = self.root / 'event.json'
        event.write_text(json.dumps({'before': self.base, 'after': self.base}))
        result = subprocess.run(['python3', '-I', str(Path(guard.__file__).resolve()),
                                 '--event', str(event)], cwd=self.root, capture_output=True)
        self.assertNotEqual(0, result.returncode)
        self.assertIn(b'Push head differs', result.stderr)

    def test_android_host_contracts_require_native_guidance(self):
        prefix = 'apps/android/android/app/src/main/java/io/ditero/app/'
        for name in ('NativeSessionVault', 'NativeAttachmentTransfers', 'ServerContext'):
            with self.subTest(name=name):
                path = prefix + name + '.java'
                self.assert_path_mapping(path, 'native', 'apps/android/android/app/src/main/', 'class ' + name + ' {}',
                                         'apps/android/README.md', '# Android\nDocument ' + name + ' contract.')

    def test_persisted_formats_require_compatibility_guidance(self):
        for path in ('src/domain/e2e/envelope.ts', 'src/domain/e2e/stream.ts',
                     'src/web/lib/e2e/device-store.ts', 'src/server/storage/fs-store.ts'):
            with self.subTest(path=path):
                mapping = 'src/server/storage/' if path.startswith('src/server/storage/') else path
                self.assert_path_mapping(path, 'compatibility', mapping,
                                         'export const persistedFormat = 2',
                                         'docs/runbooks/backup-restore.md',
                                         '# Upgrade\nBackup first. Rollback restores backup. Client versions must match.\nChanged ' + path)

    def assert_path_mapping(self, path, group, mapping, source, guide, guidance):
        # Every case compares only its own source change, never earlier cases.
        self.base = self.git('rev-parse', 'HEAD')
        self.write(path, source)
        head = self.save()

        def require_mapping():
            errors = guard.check(self.root, self.base, head)['errors']
            self.assertTrue(any(e.startswith(group + ':') for e in errors), path)

        require_mapping()
        sources, guides = guard.RULES[group]
        self.assertIn(mapping, sources)
        with patch.dict(guard.RULES, {group: (tuple(p for p in sources if p != mapping), guides)}):
            # The exact original assertion fails when this path's rule is removed.
            with self.assertRaises(AssertionError, msg='Mutation must be detected for ' + path):
                require_mapping()
        self.write(guide, guidance)
        self.documented(group, [guide])
        self.assertEqual([], self.check())
        self.base = self.git('rev-parse', 'HEAD')

    def test_repository_root_links_and_escape(self):
        self.write('docs/cli.md', '[root](../) [absolute root](/)')
        self.assertEqual([], self.check())
        self.write('docs/cli.md', '[outside](../../outside.md)')
        self.assertTrue(any('escapes Git tree' in e for e in self.check()))

    def test_release_workflow_change_qualified_by_releasing(self):
        self.write('.github/workflows/release-checks.yml', 'name: Checks')
        self.assertTrue(any(e.startswith('release:') for e in self.check()))
        self.write('RELEASING.md', '# Release\nReview documentation impact before publication.')
        self.documented('release', ['RELEASING.md'])
        self.assertEqual([], self.check())

    def static(self):
        self.write('README.md', '# Ditero')
        self.write('RELEASING.md', '# Release')
        return guard.check(self.root, None, self.save(), static=True)

    def test_static_canonical_links_and_precise_exclusions(self):
        self.write('docs/operator.md', '[broken](missing.md)')
        self.write('CHANGELOG.md', '[historical](historical-missing.md)')
        self.write('tests/README.md', '[fixture](not-a-public-guide.md)')
        result = self.static()
        self.assertEqual(1, len(result['errors']))
        self.assertIn('docs/operator.md', result['markdownPaths'])
        self.assertNotIn('CHANGELOG.md', result['markdownPaths'])
        self.write('docs/missing.md', '# Target')
        self.assertEqual([], self.static()['errors'])

    def test_static_literal_inventory_missing_and_documented(self):
        self.write('src/config/sample.ts', 'const option = process.env.DITERO_PUBLIC_SAMPLE')
        self.write('src/config/e2e.ts', 'const productionSwitch = process.env.DITERO_E2E_ENABLED')
        self.write('src/config/test-crash.ts', 'const privateSetting = process.env.DITERO_TEST_CRASH_POINT')
        self.write('src/config/sample.test.ts', 'const test = process.env.DITERO_TEST_SAMPLE')
        result = self.static()
        self.assertEqual(['DITERO_E2E_ENABLED', 'DITERO_PUBLIC_SAMPLE'], result['configurationNames'])
        self.assertIn('src/config/e2e.ts', result['configurationSourcePaths'])
        self.assertNotIn('src/config/test-crash.ts', result['configurationSourcePaths'])
        self.assertTrue(any('Undocumented literal' in e for e in result['errors']))
        self.write('.env.example', '# DITERO_PUBLIC_SAMPLE controls sample behavior.\n# DITERO_E2E_ENABLED enables encryption.')
        self.assertEqual([], self.static()['errors'])

    def test_advanced_base_pr_merge_base(self):
        self.git('checkout', '-qb', 'feature')
        self.write('src/cli/main.ts', 'export const version = 2')
        self.write('docs/cli.md', '# CLI\nNew behavior.')
        self.documented('clients', ['docs/cli.md'])
        head = self.save()
        self.git('checkout', '-qb', 'advanced-base', self.base)
        self.write('unrelated.txt', 'Advanced base')
        advanced = self.save()
        result = guard.check(self.root, advanced, head, pr=True)
        self.assertEqual(self.base, result['comparisonBase'])
        self.assertEqual(head, result['head'])
        self.assertEqual([], result['errors'])

    def test_prepublication_version_does_not_require_published_link(self):
        self.write('release.json', '{"version":"0.0.1-alpha.10"}')
        self.write('RELEASING.md', '# Release\nPrepare alpha 10 before publishing.')
        self.write('README.md', '# Ditero\nCurrent published release: alpha 9.')
        self.documented('release', ['RELEASING.md'])
        self.assertEqual([], self.check())

    def test_changed_docs_need_current_assessment(self):
        self.write('src/cli/main.ts', 'export const version = 2')
        self.write('docs/cli.md', '# CLI version two')
        self.assertTrue(self.check())
        self.documented('clients', ['docs/cli.md'])
        self.assertEqual([], self.check())
        self.write('src/cli/main.ts', 'export const version = 3')
        self.assertTrue(self.check())

    def test_cited_docs_must_change_and_be_permitted(self):
        self.write('src/cli/main.ts', 'export const version = 2')
        self.documented('clients', ['docs/cli.md'])
        self.assertTrue(any('must change' in e for e in self.check()))
        with self.assertRaises(ValueError):
            guard.declarations(json.dumps({'version': 1, 'groups': {'clients': {
                'docs': ['docs/unrelated.md'], 'note': 'A sufficiently long explanation of the source change.', 'sourceDigest': '0' * 64}}}))

    def test_ui_native_offline_boundaries(self):
        for path, group, mapping, guide in (
            ('src/web/App.tsx', 'ui', 'src/web/App.tsx', 'README.md'),
            ('src/web/index.css', 'ui', 'src/web/index.css', 'README.md'),
            ('src/web/hooks/useNativeTaskLinks.ts', 'ui', 'src/web/hooks/useNativeTaskLinks.ts', 'README.md'),
            ('src/web/components/QuickAdd.tsx', 'ui', 'src/web/components/', 'README.md'),
            ('apps/desktop/src/transport.ts', 'native', 'apps/desktop/src/', 'apps/desktop/README.md'),
            ('apps/android/android/app/src/main/java/io/ditero/app/NativeZeroTransport.java', 'native', 'apps/android/android/app/src/main/', 'apps/android/README.md'),
            ('src/web/lib/e2e/ciphertext-staging.ts', 'compatibility', 'src/web/lib/e2e/ciphertext-staging.ts', 'docs/runbooks/backup-restore.md')):
            with self.subTest(path=path):
                self.assert_path_mapping(path, group, mapping, 'source boundary changed', guide,
                                         '# Upgrade backup rollback client versions guidance ' + path)

    def test_deployment_literal_needs_named_guidance(self):
        self.write('deploy/docker/docker-compose.yml', 'environment: {DITERO_NEW_SETTING: value}')
        self.write('deploy/README.md', '# Changed deployment guidance')
        self.documented('deployment', ['deploy/README.md'])
        self.documented('configuration', ['deploy/README.md'])
        self.assertTrue(any('literal configuration' in e for e in self.check()))
        self.write('deploy/README.md', '# DITERO_NEW_SETTING controls the sample setting.')
        self.assertEqual([], self.check())

    def test_staged_new_source_and_exclusions(self):
        self.write('src/cli/new-command.ts', 'new public command')
        self.git('add', '--all')
        self.assertTrue(guard.check(self.root, self.base, self.base, staged=True)['errors'])
        self.git('reset', '--quiet', self.base)
        (self.root / 'src/cli/new-command.ts').unlink()
        for path in ('src/cli/new.test.ts', 'src/web/components/presentation.css', 'src/web/vendor/shadcn-tailwind.css', 'src/web/hooks/useWorkspaceData.ts', 'src/web/internal.ts'):
            self.write(path, 'excluded')
        self.git('add', '--all')
        self.assertEqual([], guard.check(self.root, self.base, self.base, staged=True)['errors'])
        (self.root / 'src/cli/link.ts').symlink_to('/etc/passwd')
        self.git('add', '--all')
        with self.assertRaisesRegex(ValueError, 'nonregular'):
            guard.check(self.root, self.base, self.base, staged=True)

    def test_staged_unmerged_input_rejected(self):
        oid = self.git('rev-parse', 'HEAD:src/cli/main.ts')
        subprocess.run(['git', 'update-index', '--index-info'], cwd=self.root,
                                input=f'0 {"0" * 40}\tsrc/cli/main.ts\n100644 {oid} 1\tsrc/cli/main.ts\n',
                                text=True, capture_output=True, check=True)
        with self.assertRaisesRegex(ValueError, 'Unmerged'):
            guard.check(self.root, self.base, self.base, staged=True)

    def test_combined_migration_cannot_use_later_noimpact(self):
        self.write('drizzle/0001.sql', 'alter table tasks add column example text;')
        migration = self.save()
        self.write('src/server/attachments/query.ts', 'query-only refactor')
        self.rationale('compatibility')
        head = self.save()
        self.assertEqual([], guard.check(self.root, migration, head)['errors'])
        self.assertTrue(any('recovery guidance' in e for e in guard.check(self.root, self.base, head)['errors']))



if __name__ == '__main__':
    unittest.main()
