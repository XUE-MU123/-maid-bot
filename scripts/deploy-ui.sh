#!/usr/bin/env bash
# Publish an already-built UI, retaining old assets and an ignored local snapshot.
# No network checks or service actions unless PANEL_AUTH_SERVICE is explicitly set.
set -euo pipefail
ROOT="$(realpath -- "$(dirname -- "${BASH_SOURCE[0]}")/..")"
export ROOT

python3 - <<'PY'
import os
import re
import shutil
import stat
import tarfile
import tempfile
from pathlib import Path

root = Path(os.environ['ROOT'])
web = root / 'web'
dist = root / 'frontend' / 'dist'
backup = Path(os.environ.get('MAID_BACKUP_DIR') or str(root / '.backups')).expanduser()
if not backup.is_absolute():
    backup = root / backup
backup = Path(os.path.abspath(backup))

def checked(path):
    # Resolve every existing ancestor: neither a symlink nor a non-directory may
    # redirect a write away from the intended repository-local target.
    if path.resolve() != path:
        raise SystemExit(f'Refusing redirected path: {path}')
    for part in (path, *path.parents):
        if part.is_symlink():
            raise SystemExit(f'Refusing symlink: {part}')
    return path

def plain_tree(base):
    checked(base)
    if not base.is_dir():
        raise SystemExit(f'Missing directory: {base}')
    for current, dirs, files in os.walk(base, followlinks=False):
        for name in dirs + files:
            path = checked(Path(current) / name)
            mode = path.lstat().st_mode
            if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise SystemExit(f'Refusing special file: {path}')

if web != root / 'web' or web.resolve() != root / 'web':
    raise SystemExit('Unexpected web target')
checked(root / 'frontend')
plain_tree(dist)
if not (dist / 'index.html').is_file() or not (dist / 'assets').is_dir():
    raise SystemExit('Run npm run build:web before publishing')
# The gateway serves only a flat, allowlisted assets/ directory and index.html.
if any(p.name not in ('assets', 'index.html') for p in dist.iterdir()):
    raise SystemExit('Unsupported build output: only index.html and assets/ are allowed')
if any(not p.is_file() for p in (dist / 'assets').iterdir()):
    raise SystemExit('Unsupported nested asset directory')
if web.exists():
    plain_tree(web)
    if any(web.iterdir()) and not (web / 'index.html').is_file():
        raise SystemExit('Existing UI has no index.html; refusing overwrite without a restorable backup')
checked(backup)
if backup == root or backup == dist or backup == web or web in backup.parents or dist in backup.parents:
    raise SystemExit('Backup directory must be separate from web/ and frontend/dist/')
service = os.environ.get('PANEL_AUTH_SERVICE', '')
if service and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*\.service', service):
    raise SystemExit('PANEL_AUTH_SERVICE must be an explicit systemd .service unit name')

web.mkdir(parents=True, exist_ok=True)
plain_tree(web)
backup.mkdir(parents=True, exist_ok=True)
# mkstemp creates a unique archive; no earlier snapshot can be overwritten.
# An empty first publication has no previous UI to roll back to.
if (web / 'index.html').is_file():
    fd, archive = tempfile.mkstemp(prefix='ui-before-deploy-', suffix='.tar.gz', dir=backup)
    with os.fdopen(fd, 'wb') as out, tarfile.open(fileobj=out, mode='w:gz') as tar:
        tar.add(web, arcname='web', recursive=True)
    print(f'Backup: {archive}')
else:
    print('First publication: no previous UI snapshot exists.')
assets = checked(web / 'assets')
assets.mkdir(exist_ok=True)
for source in sorted((dist / 'assets').iterdir()):
    target = checked(assets / source.name)
    if target.exists():
        if not target.is_file() or target.read_bytes() != source.read_bytes():
            raise SystemExit(f'Refusing conflicting retained asset: {target}')
    else:
        # Exclusive create prevents overwriting a retained content-hashed resource.
        with source.open('rb') as src, target.open('xb') as dst:
            shutil.copyfileobj(src, dst)
        target.chmod(0o644)
# Resources are present before the entry becomes visible; atomic within web/.
index = checked(web / 'index.html')
if index.exists() and not index.is_file():
    raise SystemExit('index.html must be a regular file')
fd, temporary = tempfile.mkstemp(prefix='.index-', suffix='.next', dir=web)
temporary = checked(Path(temporary))
if temporary.parent != root / 'web' or index != root / 'web' / 'index.html':
    raise SystemExit('Unexpected entry target')
with os.fdopen(fd, 'wb') as out:
    out.write((dist / 'index.html').read_bytes())
    out.flush()
    os.fsync(out.fileno())
temporary.chmod(0o644)
os.replace(temporary, index)
print('UI published; old assets retained. No bot data or code changed.')
PY

if [[ -n "${PANEL_AUTH_SERVICE:-}" ]]; then
    systemctl restart -- "$PANEL_AUTH_SERVICE"
    printf 'Restarted explicitly requested gateway unit: %s\n' "$PANEL_AUTH_SERVICE"
else
    printf '%s\n' 'No service restarted. Restart your gateway explicitly to reload its static snapshot.'
fi
