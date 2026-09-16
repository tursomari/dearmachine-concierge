#!/usr/bin/env python3
"""Exercise recursive pins, URL rewrites and isolation with real offline Git."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

# The self-test must leave the source checkout byte-for-byte unchanged.
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('git-fixture.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class GitFixture(unittest.TestCase):
    def test_recursive_pins_and_isolation(self):
        with tempfile.TemporaryDirectory(prefix='qse-git-test-') as directory:
            root = Path(directory)
            old = os.environ.copy()
            self.addCleanup(lambda: (os.environ.clear(), os.environ.update(old)))
            home = root / 'home'
            home.mkdir()
            os.environ.update(HOME=str(home), GIT_CONFIG_GLOBAL=str(home / '.gitconfig'), GIT_CONFIG_NOSYSTEM='1')
            source = root / 'source'
            source.mkdir()

            def seed(path):
                path.mkdir(parents=True, exist_ok=True)
                fixture.git(path, 'init', '--quiet', '--template=', '--initial-branch=main')
                fixture.git(path, 'config', 'user.name', 'QSE fixture test')
                fixture.git(path, 'config', 'user.email', 'qse@example.invalid')
                fixture.git(path, 'config', 'commit.gpgsign', 'false')
                (path / 'tracked').write_text('pinned\n')
                fixture.git(path, 'add', 'tracked')
                fixture.git(path, 'commit', '--quiet', '-m', 'fixture')
                return fixture.text(path, 'rev-parse', 'HEAD')

            seed(source)
            component = source / 'component'
            seed(component)
            nested = component / 'nested'
            nested_pin = seed(nested)

            def link(parent, name, revision):
                fixture.git(parent, 'config', '--file', '.gitmodules', f'submodule.{name}.path', name)
                fixture.git(parent, 'config', '--file', '.gitmodules', f'submodule.{name}.url', f'https://qse.invalid/{name}.git')
                fixture.git(parent, 'add', '.gitmodules')
                fixture.git(parent, 'update-index', '--add', '--cacheinfo', f'160000,{revision},{name}')
                fixture.git(parent, 'commit', '--quiet', '-m', 'pin child')
                return fixture.text(parent, 'rev-parse', 'HEAD')

            component_pin = link(component, 'nested', nested_pin)
            root_pin = link(source, 'component', component_pin)
            # A stale working checkout must not replace the umbrella's pin.
            (component / 'tracked').write_text('new unpinned content\n')
            fixture.git(component, 'commit', '--quiet', '-am', 'unpinned')
            (source / '.secrets').write_text('do not copy\n')
            (source / '.git/hooks').mkdir()
            (source / '.git/hooks/private-hook').write_text('private host state\n')
            fixture.git(source, 'config', 'private.secret', 'do not copy')
            payload = root / 'payload'
            fixture.export(source, payload)
            fixture.restore(payload, root / 'restored')
            checkout = root / 'restored/checkout'
            self.assertEqual(fixture.text(checkout, 'rev-parse', 'HEAD'), root_pin)
            self.assertEqual(fixture.text(checkout / 'component', 'rev-parse', 'HEAD'), component_pin)
            self.assertEqual((checkout / 'component/tracked').read_text(), 'pinned\n')
            self.assertFalse((checkout / '.secrets').exists())
            self.assertFalse((checkout / '.git/hooks/private-hook').exists())
            self.assertNotIn('private.secret', fixture.text(checkout, 'config', '--local', '--list'))
            # The configured release identity stays HTTPS while actual transport is local.
            self.assertEqual(fixture.text(checkout, 'config', '--get', 'remote.origin.url'), 'https://qse.invalid/umbrella.git')
            self.assertTrue(fixture.text(checkout, 'remote', 'get-url', 'origin').startswith('file://'))
            with self.assertRaises(subprocess.CalledProcessError):
                fixture.git(checkout, 'ls-remote', 'https://unexpected.invalid/repo', stderr=subprocess.DEVNULL)
            (nested / '.env').write_text('secret\n')
            fixture.git(nested, 'add', '.env')
            fixture.git(nested, 'commit', '--quiet', '-m', 'unsafe')
            link(component, 'nested', fixture.text(nested, 'rev-parse', 'HEAD'))
            link(source, 'component', fixture.text(component, 'rev-parse', 'HEAD'))
            with self.assertRaisesRegex(ValueError, 'credential-like'):
                fixture.export(source, root / 'unsafe')


if __name__ == '__main__':
    unittest.main()
