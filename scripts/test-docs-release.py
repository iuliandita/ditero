#!/usr/bin/env python3
"""Offline release-epoch identity and mandatory-tool fixtures."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('docs_release', Path(__file__).with_name('docs-release.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ReleaseDocumentation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.policy = self.root / 'policy.py'
        self.policy.write_text('import sys\nassert sys.argv[1:] == '+
                               "['--base', 'BASE', '--head', 'HEAD']\n")
        self.base = self.save()
        self.git('tag', '-a', guard.TAG, '-m', 'Fixture')
        self.tag = self.git('rev-parse', f'refs/tags/{guard.TAG}')
        self.policy.write_text('# later query-only change\n')
        self.head = self.save()
        self.policy.write_text('import sys\nassert sys.argv[1:] == '+
                               repr(['--base', self.base, '--head', self.head])+'\n')
        self.pins = patch.multiple(guard, BASE=self.base, TAG_OBJECT=self.tag)
        self.pins.start()
        self.addCleanup(self.pins.stop)

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, text=True,
                                       stderr=subprocess.PIPE).strip()

    def save(self):
        self.git('add', '--all')
        self.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture')
        return self.git('rev-parse', 'HEAD')

    def test_always_passes_original_epoch_through_later_changes(self):
        guard.check(self.root, self.head, self.policy)

    def test_baseline_tag_reset_rejected(self):
        self.git('tag', '-fa', guard.TAG, '-m', 'Reset')
        with self.assertRaisesRegex(ValueError, 'epoch tag'):
            guard.check(self.root, self.head, self.policy)

    def test_missing_policy_fails(self):
        with self.assertRaisesRegex(ValueError, 'regular file'):
            guard.check(self.root, self.head, self.root / 'missing.py')

    def test_missing_required_runtime_fails(self):
        with patch.object(guard.sys, 'executable', str(self.root / 'missing-python')):
            with self.assertRaises(FileNotFoundError):
                guard.check(self.root, self.head, self.policy)

    def test_failed_policy_is_not_alignment(self):
        self.policy.write_text('raise SystemExit(1)\n')
        with self.assertRaises(subprocess.CalledProcessError):
            guard.check(self.root, self.head, self.policy)

    def test_head_before_epoch_fails(self):
        (self.root / 'new.txt').write_text('new epoch')
        later = self.save()
        self.git('tag', '-fa', guard.TAG, '-m', 'New epoch')
        tag = self.git('rev-parse', f'refs/tags/{guard.TAG}')
        self.policy.write_text('pass\n')
        with patch.object(guard, 'BASE', later), patch.object(guard, 'TAG_OBJECT', tag):
            with self.assertRaises(subprocess.CalledProcessError):
                guard.check(self.root, self.base, self.policy)


if __name__ == '__main__':
    unittest.main()
