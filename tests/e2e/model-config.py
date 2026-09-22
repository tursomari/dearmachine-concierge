#!/usr/bin/env python3
"""Private QSE model selections; never put credential values in argv or receipts."""
import base64
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.parse import urlsplit

BUILTINS = {'openrouter', 'openai', 'deepseek'}


def private_file(raw):
    if not isinstance(raw, str) or not Path(raw).is_absolute():
        raise ValueError('configuration and credential paths must be absolute')
    path = Path(raw)
    meta = path.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid() or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_size > 16384:
        raise ValueError('configuration and credentials must be owned, mode 0600 regular non-symlink files of at most 16 KiB')
    return path


def selection(value):
    required = {'provider', 'model', 'reasoningEffort', 'credentialFile'}
    if not isinstance(value, dict) or set(value) not in (required, required | {'endpoint'}):
        raise ValueError('model selection requires provider, model, reasoningEffort, credentialFile and optional endpoint only')
    if not isinstance(value['provider'], str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', value['provider']):
        raise ValueError('provider must be a lowercase provider identifier')
    if not isinstance(value['model'], str) or not value['model'].strip() or re.search(r'[\x00-\x1f\x7f]', value['model']):
        raise ValueError('model must be a nonempty model ID without control characters')
    if value['reasoningEffort'] not in ('default', 'minimal', 'low', 'medium', 'high', 'xhigh'):
        raise ValueError('reasoningEffort must be explicit: default, minimal, low, medium, high or xhigh')
    if 'endpoint' in value:
        endpoint = value['endpoint']
        if not isinstance(endpoint, str):
            raise ValueError('endpoint must be an HTTPS Chat Completions URL')
        parsed = urlsplit(endpoint)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or re.search(r'\s|[\x00-\x1f\x7f]', endpoint):
            raise ValueError('endpoint requires HTTPS without credentials, query, fragment or whitespace')
        if value['provider'] in BUILTINS:
            raise ValueError('custom endpoints require a distinct custom provider identifier')
    elif value['provider'] not in BUILTINS:
        raise ValueError('this provider requires an explicit Chat Completions endpoint')
    private_file(value['credentialFile'])
    return dict(value)


def load(path):
    if path:
        try:
            value = json.loads(private_file(path).read_text())
        except (json.JSONDecodeError, UnicodeError):
            raise ValueError('model configuration is not valid JSON') from None
    else:
        value = dict(provider='openrouter', model='z-ai/glm-5.3-flash', reasoningEffort='high',
                     credentialFile=os.environ.get('OPENROUTER_KEY_PATH', str(Path.home() / '.secrets/openrouter/work-api-key.txt')))
    if not isinstance(value, dict):
        raise ValueError('model configuration must be an object')
    backend_id = value.get('backendId', 'forge')
    if backend_id not in ('forge', 'omp'):
        raise ValueError('backendId must be forge or omp')
    shared = selection({k: v for k, v in value.items() if k not in ('backend', 'backendId')})
    backend = selection(value.get('backend', shared))
    if backend_id == 'forge' and 'endpoint' in backend and backend['reasoningEffort'] != 'default':
        raise ValueError('Forge 2.13.21 cannot forward custom-provider reasoning; explicitly configure a supported backend selection or provider-default reasoning')
    if backend_id == 'omp' and 'endpoint' in backend and not backend['endpoint'].endswith('/chat/completions'):
        raise ValueError('OMP custom endpoint must end with /chat/completions')
    return {'shared': shared, 'backend': backend, 'backendId': backend_id}


def credential(path):
    data = private_file(str(path)).read_bytes()
    key = data[:-1] if data.endswith(b'\n') else data
    if not key or any(c < 33 or c > 126 for c in key):
        raise ValueError('credential file must contain one nonempty printable ASCII key, optionally followed by a newline')
    return key


def stage(config, root):
    root = Path(root)
    secrets = root / 'model-secrets'
    secrets.mkdir(mode=0o700)
    sanitized = {'backendId': config['backendId']}
    for role in ('shared', 'backend'):
        value = config[role]
        (secrets / role).write_bytes(credential(value['credentialFile']) + b'\n')
        (secrets / role).chmod(0o600)
        sanitized[role] = {k: v for k, v in value.items() if k != 'credentialFile'}
    target = root / 'model-config.json'
    target.write_text(json.dumps(sanitized) + '\n')
    target.chmod(0o600)


def scan(root, artifacts):
    root = Path(root)
    keys = [credential(root / 'model-secrets' / role) for role in ('shared', 'backend')]
    keys.append(credential(root / 'agentmail.key'))
    needles = [variant for key in keys for variant in (key, base64.b64encode(key), key.hex().encode(), json.dumps(key.decode())[1:-1].encode())]
    for artifact in artifacts:
        if any(key in Path(artifact).read_bytes() for key in needles):
            raise ValueError('credential material appeared in a QSE artifact')


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'validate':
            load(sys.argv[2])
        elif sys.argv[1] == 'stage':
            stage(load(sys.argv[2]), sys.argv[3])
        elif sys.argv[1] == 'copy-key':
            target = Path(sys.argv[3])
            target.write_bytes(credential(sys.argv[2]) + b'\n')
            target.chmod(0o600)
        elif sys.argv[1] == 'scan':
            scan(sys.argv[2], sys.argv[3:])
        else:
            raise ValueError('unknown model configuration operation')
    except (ValueError, OSError) as error:
        # OS errors may contain private paths; JSON errors may contain input.
        print('QSE model configuration: ' + (str(error) if isinstance(error, ValueError) else 'private file unavailable'), file=sys.stderr)
        sys.exit(1)
