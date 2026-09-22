#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
sys.dont_write_bytecode = True
import unittest

spec = importlib.util.spec_from_file_location('model_config', Path(__file__).with_name('model-config.py'))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class ModelConfigTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.key = self.root / 'key'
        self.key.write_text('test-private-key\n')
        self.key.chmod(0o600)
        self.path = self.root / 'models.json'
        self.value = dict(provider='openai', model='test-model', reasoningEffort='high', credentialFile=str(self.key))

    def load(self, value):
        self.path.write_text(json.dumps(value))
        self.path.chmod(0o600)
        return config.load(str(self.path))

    def test_builtin_defaults_backend_to_same_explicit_selection(self):
        result = self.load(self.value)
        self.assertEqual(result['shared'], result['backend'])

    def test_independent_custom_provider_and_builtin_backend(self):
        value = dict(self.value, provider='example', endpoint='https://models.example.test/v1/chat/completions', backend=self.value)
        result = self.load(value)
        config.stage(result, self.root)
        receipt = (self.root / 'model-config.json').read_text()
        self.assertNotIn(str(self.key), receipt)
        self.assertNotIn('test-private-key', receipt)
        self.assertEqual(json.loads(receipt)['shared']['reasoningEffort'], 'high')
        artifact = self.root / 'artifact'
        artifact.write_text('safe receipt')
        (self.root / 'agentmail.key').write_text('test-mail-key\n')
        (self.root / 'agentmail.key').chmod(0o600)
        config.scan(self.root, [artifact])
        artifact.write_text(config.base64.b64encode(b'test-private-key').decode())
        with self.assertRaisesRegex(ValueError, 'credential material'):
            config.scan(self.root, [artifact])

    def test_custom_forge_requires_explicit_default_reasoning(self):
        value = dict(self.value, provider='example', endpoint='https://models.example.test/v1/chat/completions')
        with self.assertRaisesRegex(ValueError, 'cannot forward'):
            self.load(value)
        self.assertEqual(self.load(dict(value, reasoningEffort='default'))['backend']['reasoningEffort'], 'default')

    def test_omp_shares_custom_provider_and_high_reasoning(self):
        value = dict(self.value, backendId='omp', provider='example', endpoint='https://models.example.test/v1/chat/completions')
        result = self.load(value)
        self.assertEqual(result['shared'], result['backend'])
        config.stage(result, self.root)
        staged = json.loads((self.root / 'model-config.json').read_text())
        self.assertEqual(staged['backendId'], 'omp')
        self.assertEqual(staged['backend']['reasoningEffort'], 'high')
        self.assertNotIn(str(self.key), json.dumps(staged))

    def test_rejects_unknown_backend_and_unrepresentable_omp_endpoint(self):
        with self.assertRaisesRegex(ValueError, 'backendId'):
            self.load(dict(self.value, backendId='unknown'))
        with self.assertRaisesRegex(ValueError, 'endpoint'):
            self.load(dict(self.value, backendId='omp', provider='example', endpoint='https://models.example.test/other'))

    def test_rejects_unsafe_inputs(self):
        for patch in [dict(apiKey='secret'), dict(credentialFile='relative'), dict(provider='unknown'),
                      dict(reasoningEffort='invented'), dict(model='model\nsecret'),
                      dict(provider='example', endpoint='http://models.example.test'),
                      dict(provider='example', endpoint='https://user:secret@models.example.test'),
                      dict(provider='example', endpoint='https://models.example.test?key=secret')]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.load(dict(self.value, **patch))
        self.key.chmod(0o644)
        with self.assertRaises(ValueError):
            self.load(self.value)
        self.key.chmod(0o600)
        link = self.root / 'link'
        link.symlink_to(self.key)
        with self.assertRaises(ValueError):
            self.load(dict(self.value, credentialFile=str(link)))

    def test_accepts_key_with_or_without_one_final_newline(self):
        for data in (b'test-key', b'test-key\n'):
            self.key.write_bytes(data)
            self.assertEqual(config.credential(self.key), b'test-key')

    def test_rejects_multiline_credentials_without_echoing_them(self):
        self.key.write_text('first-secret\nsecond-secret\n')
        with self.assertRaisesRegex(ValueError, '^credential file must'):
            config.stage(self.load(self.value), self.root)


if __name__ == '__main__':
    unittest.main()
