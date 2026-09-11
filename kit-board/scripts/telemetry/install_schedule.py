#!/usr/bin/env python3
"""Install this collector hourly on macOS or Windows; never invokes an AI agent."""
import argparse
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import os

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--config', required=True)
parser.add_argument('--refresh-feeds', action='store_true')
parser.add_argument('--uninstall', action='store_true')
args = parser.parse_args()
config_path = Path(args.config).expanduser().resolve()
config = json.loads(config_path.read_text())
source = config['source_id']
if not all(c in '0123456789abcdef-' for c in source) or len(source) != 36:
    raise ValueError('Invalid source identity')
script = Path(__file__).with_name('collect.py').resolve()
argv = [sys.executable, str(script), '--config', str(config_path)]
if args.refresh_feeds:
    argv.append('--refresh-feeds')
if sys.platform == 'darwin':
    label = 'com.personal-observatory.usage.' + source
    plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    service = f'gui/{os.getuid()}/{label}'
    existing = subprocess.run(['launchctl', 'print', service], capture_output=True).returncode == 0
    if existing:
        subprocess.run(['launchctl', 'bootout', service], check=True, capture_output=True)
    if args.uninstall:
        plist.unlink(missing_ok=True)
    else:
        logs = config_path.parent / 'logs'; logs.mkdir(mode=0o700, exist_ok=True)
        plist.parent.mkdir(exist_ok=True)
        plist.write_bytes(plistlib.dumps({'Label': label, 'ProgramArguments': argv,
            'StartInterval': 3600, 'RunAtLoad': True, 'ProcessType': 'Background',
            'StandardOutPath': str(logs / (source + '.log')), 'StandardErrorPath': str(logs / (source + '.error.log'))}))
        os.chmod(plist, 0o600)
        subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True, capture_output=True)
elif sys.platform == 'win32':
    name = 'Personal Observatory Usage ' + source
    command = ['schtasks', '/Delete', '/TN', name, '/F'] if args.uninstall else ['schtasks', '/Create', '/TN', name, '/TR', subprocess.list2cmdline(argv), '/SC', 'HOURLY', '/MO', '1', '/IT', '/F']
    subprocess.run(command, check=True, capture_output=True)
else:
    raise SystemExit('Use your system scheduler to run collect.py hourly. No schedule was installed.')
print(json.dumps({'ok': True, 'installed': not args.uninstall, 'source_id': source, 'interval_minutes': 60}))
