#!/usr/bin/env python3
"""Transfer exact committed trees, then clone isolated local QSE origins.

Packs contain one original commit and its complete tree, not its ancestors or
host Git administration. A shallow boundary preserves the original commit ID.
"""
import argparse
import json
from pathlib import Path
import subprocess


def git(repo, *args, **kwargs):
    return subprocess.check_output(['git', '-C', str(repo), *args], **kwargs)


def text(repo, *args):
    return git(repo, *args).decode().strip()


def export(source, destination):
    destination.mkdir()
    manifest = []

    def visit(repo, revision, path, url):
        if text(repo, 'rev-parse', '--show-toplevel') != str(repo.resolve()):
            raise ValueError(f'submodule is not initialized: {path}')
        entries = git(repo, 'ls-tree', '-rz', revision).split(b'\0')
        children = []
        for entry in filter(None, entries):
            metadata, name = entry.split(b'\t', 1)
            mode, kind, oid = metadata.decode().split()
            member = name.decode()
            parts = Path(member).parts
            if any(p in ('.git', '.ssh', '.secrets', '.forge', '.credentials.json', '.env')
                   or (p.startswith('.env.') and p not in ('.env.example', '.env.sample', '.env.template')) for p in parts):
                raise ValueError(f'credential-like tracked path: {path}/{member}')
            if kind == 'commit':
                children.append((member, oid))
        number = len(manifest)
        manifest.append(dict(path=path, revision=revision, url=url, pack=f'{number}.pack'))
        # Explicit object list: the commit plus every tree/blob, with no parents.
        objects = revision.encode() + b'\n' + git(repo, 'rev-list', '--objects', '--no-object-names', f'{revision}^{{tree}}')
        # Stable pack bytes let Docker reuse the image for unchanged pins.
        with (destination / f'{number}.pack').open('wb') as output:
            subprocess.run(['git', '-C', str(repo), 'pack-objects', '--threads=1', '--stdout'],
                           input=objects, stdout=output, check=True)
        if children:
            modules = git(repo, 'config', '--blob', f'{revision}:.gitmodules', '--null', '--get-regexp', r'^submodule\..*\.path$')
            names = {}
            for entry in modules.split(b'\0'):
                if entry:
                    key, member = entry.decode().split('\n', 1)
                    names[member] = key[:-5]
            for member, oid in children:
                child_url = text(repo, 'config', '--blob', f'{revision}:.gitmodules', '--get', names[member] + '.url')
                if not child_url.startswith('https://') or any(c in child_url for c in ('@', '?', '#')):
                    raise ValueError(f'fixture requires a credential-free absolute HTTPS submodule URL: {member}')
                visit(repo / member, oid, member if path == '.' else f'{path}/{member}', child_url)

    visit(source, text(source, 'rev-parse', 'HEAD'), '.', 'https://qse.invalid/umbrella.git')
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


def restore(payload, destination):
    destination.mkdir()
    origins = destination / 'origins'
    origins.mkdir()
    manifest = json.loads((payload / 'manifest.json').read_text())
    # These settings belong only to the disposable HOME, never the host config.
    git(destination, 'config', '--global', 'protocol.allow', 'never')
    git(destination, 'config', '--global', 'protocol.file.allow', 'always')
    for number, row in enumerate(manifest):
        origin = origins / f'{number}.git'
        git(destination, 'init', '--quiet', '--bare', '--template=', '--initial-branch=main', str(origin))
        with (payload / row['pack']).open('rb') as pack:
            git(origin, 'index-pack', '--stdin', stdin=pack)
        (origin / 'shallow').write_text(row['revision'] + '\n')
        git(origin, 'update-ref', 'refs/heads/main', row['revision'])
        git(origin, 'fsck', '--strict', '--no-reflogs')
        git(destination, 'config', '--global', '--add', f'url.{origin.as_uri()}.insteadOf', row['url'])
    checkout = destination / 'checkout'
    git(destination, 'clone', '--quiet', '--recurse-submodules', '--shallow-submodules',
        '--', manifest[0]['url'], str(checkout))
    remote = text(checkout, 'config', '--get', 'remote.origin.url')
    advertised = text(checkout, 'ls-remote', '--symref', remote, 'HEAD')
    if f"{manifest[0]['revision']}\tHEAD" not in advertised or 'ref: refs/heads/main\tHEAD' not in advertised:
        raise ValueError('local origin does not advertise the pinned default branch')
    for row in manifest:
        repo = checkout / row['path']
        if text(repo, 'rev-parse', 'HEAD') != row['revision']:
            raise ValueError(f"incorrect submodule revision: {row['path']}")
        if text(repo, 'status', '--porcelain', '--untracked-files=all'):
            raise ValueError(f"dirty fixture: {row['path']}")
        if text(repo, 'rev-list', '--count', 'HEAD') != '1':
            raise ValueError('fixture unexpectedly contains history')
    print(checkout)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['export', 'restore'])
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    if args.operation == 'export':
        export(args.source.resolve(), args.destination.resolve())
    else:
        restore(args.source.resolve(), args.destination.resolve())
