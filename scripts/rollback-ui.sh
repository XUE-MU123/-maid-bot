#!/usr/bin/env bash
# Static UI only: list snapshots, restore the newest by mtime, or select an archive.
# Usage: bash scripts/rollback-ui.sh [list|last|ARCHIVE]
set -euo pipefail
ROOT="$(realpath -- "$(dirname -- "${BASH_SOURCE[0]}")/..")"
export ROOT

python3 - "${1:-list}" <<'PY'
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

root = Path(os.environ['ROOT'])
web = root / 'web'
backup = Path(os.environ.get('MAID_BACKUP_DIR') or str(root / '.backups')).expanduser()
if not backup.is_absolute():
    backup = root / backup
backup = Path(os.path.abspath(backup))

def checked(path):
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

checked(backup)
checked(web)
if web != root / 'web' or web.resolve() != root / 'web':
    raise SystemExit('Unexpected web target')
if backup == root or backup == web or web in backup.parents or backup == root / 'frontend' / 'dist' or (root / 'frontend' / 'dist') in backup.parents:
    raise SystemExit('Backup directory must be separate from UI directories')
command = sys.argv[1]
# Every deployment and rollback snapshot is eligible; no fixed historical name.
snapshots = sorted((p for p in backup.glob('ui-*.tar.gz') if p.is_file() and not p.is_symlink()),
                   key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
if command == 'list':
    for path in snapshots:
        print(path.name)
    if not snapshots:
        print('No UI snapshots found.')
    raise SystemExit(0)
if command == 'last':
    if not snapshots:
        raise SystemExit('No UI snapshot available')
    archive = snapshots[0]
else:
    requested = Path(command).expanduser()
    # Bare names select the backup directory; paths explicitly select elsewhere.
    archive = backup / requested if len(requested.parts) == 1 else requested
    if not archive.is_absolute():
        archive = Path.cwd() / archive
    archive = Path(os.path.abspath(archive))
checked(archive)
if not archive.is_file():
    raise SystemExit('Snapshot must be a regular, non-symlink file')
service = os.environ.get('PANEL_AUTH_SERVICE', '')
if service and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*\.service', service):
    raise SystemExit('PANEL_AUTH_SERVICE must be an explicit systemd .service unit name')
if web.exists():
    plain_tree(web)

# Validate every member before creating a backup or writing any UI file. Never
# extractall: only explicitly checked regular files and directories are accepted.
with tarfile.open(archive, 'r:gz') as tar:
    members = tar.getmembers()
    seen = set()
    entries = []
    total = 0
    for member in members:
        raw = member.name
        path = PurePosixPath(raw)
        if (path.is_absolute() or not path.parts or path.parts[0] != 'web'
                or '..' in path.parts or '\\' in raw or '\x00' in raw
                or raw.startswith('./') or '//' in raw
                or member.issym() or member.islnk()
                or not (member.isdir() or member.isfile())
                or (path == PurePosixPath('web') and not member.isdir())
                or path in seen):
            raise SystemExit('Rejected unsafe, duplicate, linked, or out-of-web archive member')
        seen.add(path)
        target = checked(root.joinpath(*path.parts))
        if target != web and web not in target.parents:
            raise SystemExit('Unexpected restore target')
        if target.exists() and (member.isdir() != target.is_dir()):
            raise SystemExit(f'Refusing target type conflict: {target}')
        total += member.size
        if len(members) > 10000 or total > 256 * 1024 * 1024:
            raise SystemExit('Snapshot exceeds restore limits')
        entries.append((member, target))
    if not any(m.isfile() and p == web / 'index.html' for m, p in entries):
        raise SystemExit('Snapshot has no web/index.html')
    # Reject files used as parent directories within the archive.
    files = {p for m, p in entries if m.isfile()}
    if any(any(parent in files for parent in p.parents) for _, p in entries):
        raise SystemExit('Archive has conflicting parent paths')
    web.mkdir(parents=True, exist_ok=True)
    backup.mkdir(parents=True, exist_ok=True)
    if (web / 'index.html').is_file():
        fd, current = tempfile.mkstemp(prefix='ui-before-rollback-', suffix='.tar.gz', dir=backup)
        with os.fdopen(fd, 'wb') as out, tarfile.open(fileobj=out, mode='w:gz') as saved:
            saved.add(web, arcname='web', recursive=True)
        print(f'Backup before overwrite: {current}')
    elif any(web.iterdir()):
        raise SystemExit('Existing UI has no index.html; refusing overwrite without a restorable backup')
    else:
        print('No current UI to overwrite or back up.')
    # Restore all non-entry resources first. Retain unrelated existing assets.
    ordered = sorted(entries, key=lambda pair: (pair[1] == web / 'index.html', len(pair[1].parts), str(pair[1])))
    for member, target in ordered:
        checked(target)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        checked(target.parent)
        fd, temporary = tempfile.mkstemp(prefix='.restore-', suffix='.next', dir=target.parent)
        temporary = checked(Path(temporary))
        if temporary.parent != target.parent or (target != web / 'index.html' and web not in target.parents):
            raise SystemExit('Unexpected atomic restore target')
        source = tar.extractfile(member)
        if source is None:
            raise SystemExit('Unreadable archive file')
        with source, os.fdopen(fd, 'wb') as out:
            shutil.copyfileobj(source, out)
            out.flush()
            os.fsync(out.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, target)
print(f'Restored UI snapshot: {archive.name}. Existing directories and other assets retained.')
PY

# Listing is always read-only, even if the optional restart variable is present.
if [[ "${1:-list}" != list && -n "${PANEL_AUTH_SERVICE:-}" ]]; then
    systemctl restart -- "$PANEL_AUTH_SERVICE"
    printf 'Restarted explicitly requested gateway unit: %s\n' "$PANEL_AUTH_SERVICE"
elif [[ "${1:-list}" != list ]]; then
    printf '%s\n' 'No service restarted. Restart your gateway explicitly to reload its static snapshot.'
fi
