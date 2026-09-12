#!/usr/bin/env python3
import base64
import io
import json
from pathlib import Path
import zipfile
root = Path(__file__).resolve().parent.parent
def add_file(archive, source, name):
    # Keep bundle bytes stable across operating systems and zlib versions.
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = 0o100644 << 16
    contents = source.read_text(encoding='utf-8').replace('\r\n', '\n').replace('\r', '\n')
    archive.writestr(info, contents.encode('utf-8'))

bundles = {}
for kind, folder in [('browser', root / 'browser/claude-quota'), ('local', root / 'scripts/telemetry')]:
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_STORED) as archive:
        for file in sorted(folder.iterdir()):
            if file.suffix in ('.py', '.js', '.html', '.css', '.json'):
                add_file(archive, file, file.name)
        add_file(archive, root / 'docs/usage-collection.md', 'README.md')
    bundles[kind] = base64.b64encode(output.getvalue()).decode()
(root / 'lib/generated/collector-bundles.json').write_text(json.dumps(bundles), encoding='utf-8')
print('Built private collector download bundles')
