"""Writes side-records.json next to this file: the synthetic side-record parity corpus.

Run `python3 side_records.py` from this directory. Every string is synthetic; special
characters are built with chr() so the source stays ASCII.
"""
import copy
import json
from pathlib import Path

OUT = Path(__file__).with_name('side-records.json')

H64A = 'a' * 64
H64B = 'b' * 64
H64C = 'c' * 64
HN = 'h:0123456789abcdef'
LS, PS, BOM, NEL, SHY, ZWJ, NBSP, IDSP = chr(0x2028), chr(0x2029), chr(0xFEFF), chr(0x85), chr(0xAD), chr(0x200D), chr(0xA0), chr(0x3000)
CAFE = 'Caf' + chr(0xE9) + ' ' + chr(0x65E5) + chr(0x672C)
ASTRAL = chr(0x1F600)


def header(record_type, n):
    return {
        'record_type': record_type,
        'record_id': '11111111-1111-4111-8111-%012d' % n,
        'binding_id': '22222222-2222-4222-8222-222222222222',
        'adapter': 'codex_execution',
        'observed_at': '2026-09-02T03:20:00.000Z',
        'parser_version': '2.2.0',
    }


counter = [0]


def rec(record_type, **fields):
    counter[0] += 1
    value = header(record_type, counter[0])
    value.update(fields)
    return value


def label(kind, key, text, role=None, parent_key=None):
    return rec('name.label', kind=kind, key=key, label=text, role=role, parent_key=parent_key)


def catalog(name, position=0, state='active', app='codex_desktop', project_key=H64A):
    return rec('project.catalog', app=app, project_key=project_key, name=name, position=position, state=state)


def membership(member_kind, resolution, project_key, member_key=H64B):
    return rec('project.membership', member_kind=member_kind, member_key=member_key, project_key=project_key, resolution=resolution)


valid = [
    ('tool label', label('tool', HN, 'PowerShell')),
    ('namespace label', label('tool_namespace', HN, 'Demo Connector')),
    ('custom agent name label', label('agent_name', HN, 'sample-reviewer')),
    ('agent label with a subagent role', label('agent', H64A, 'explorer', role='subagent')),
    ('agent label with no role', label('agent', H64A, 'default')),
    ('session agent main', label('session_agent', H64A, 'main', role='main')),
    ('session agent subagent with a parent', label('session_agent', H64A, 'explore', role='subagent', parent_key=H64B)),
    ('unicode label', label('tool', HN, CAFE + ' ' + ASTRAL)),
    ('inner spaces kept', label('tool', HN, 'a  b' + NBSP + 'c')),
    ('label of exactly 200 characters', label('tool', HN, 'x' * 200)),
    ('label of 200 astral characters (400 UTF-16 units)', label('tool', HN, ASTRAL * 200)),
    ('catalog, active', catalog('Sample Project')),
    ('catalog, removed, no position', catalog('Old Sample', position=None, state='removed')),
    ('catalog, reserved app', catalog('Reserved App Project', app='cursor')),
    ('catalog name of exactly 80 characters', catalog('p' * 80, position=2147483647)),
    ('catalog untitled', catalog('Untitled project')),
    ('membership app assignment', membership('session', 'app_assignment', H64A)),
    ('membership inherited', membership('session', 'inherited', H64A)),
    ('membership root prefix', membership('working_directory', 'root_prefix', H64A)),
    ('membership worktree root prefix', membership('working_directory', 'worktree_root_prefix', H64A)),
    ('membership projectless', membership('session', 'projectless', None)),
    ('membership outside roots', membership('working_directory', 'outside_roots', None)),
    ('membership no folder', membership('session', 'no_folder', None)),
]

invalid = []


def bad(name, expressible, record):
    invalid.append({'reason': name, 'schema_expressible': expressible, 'record': record})


def with_(record, **changes):
    r = copy.deepcopy(record)
    for k, v in changes.items():
        if v is KeyError:
            del r[k]
        else:
            r[k] = v
    return r


base_label = label('tool', HN, 'PowerShell')
base_agent = label('agent', H64A, 'explorer', role='subagent')
base_catalog = catalog('Sample Project')
base_membership = membership('session', 'app_assignment', H64A)

bad('tool key must be h:16 hex, not 64 hex', False, with_(base_label, key=H64A))
bad('namespace key must be h:16 hex', False, with_(base_label, kind='tool_namespace', key=H64A))
bad('agent_name key must be h:16 hex', False, with_(base_label, kind='agent_name', key=H64C))
bad('agent key must be 64 hex', False, with_(base_agent, key=HN))
bad('session agent key must be 64 hex', False, with_(base_agent, kind='session_agent', key=HN))
bad('key is neither form', True, with_(base_label, key='h:0123'))
bad('uppercase key', True, with_(base_label, key='h:0123456789ABCDEF'))
bad('readable key', True, with_(base_label, key='PowerShell'))
bad('unknown kind', True, with_(base_label, kind='mcp_server'))
bad('role on a tool label', False, with_(base_label, role='main'))
bad('role on a namespace label', False, with_(base_label, kind='tool_namespace', role='subagent'))
bad('role on an agent_name label', False, with_(base_label, kind='agent_name', role='subagent'))
bad('unknown role', True, with_(base_agent, role='worker'))
bad('parent key on an agent label', False, with_(base_agent, parent_key=H64B))
bad('parent key on a tool label', False, with_(base_label, parent_key=H64B))
bad('parent key not hex', True, with_(base_agent, kind='session_agent', parent_key='x' * 64))
bad('missing role', True, with_(base_label, role=KeyError))
bad('missing parent key', True, with_(base_label, parent_key=KeyError))
bad('empty label', True, with_(base_label, label=''))
bad('label of 201 characters', True, with_(base_label, label='x' * 201))
bad('label of 201 astral characters', True, with_(base_label, label=ASTRAL * 201))
bad('label blank after trim', False, with_(base_label, label='   '))
bad('label with a leading space', False, with_(base_label, label=' PowerShell'))
bad('label with a trailing no-break space', False, with_(base_label, label='PowerShell' + NBSP))
bad('label with a trailing ideographic space', False, with_(base_label, label='PowerShell' + IDSP))
bad('label with U+2028', True, with_(base_label, label='a' + LS + 'b'))
bad('label with U+2029', True, with_(base_label, label='a' + PS + 'b'))
bad('label with U+FEFF', True, with_(base_label, label=BOM + 'ab'))
bad('label with U+0085', True, with_(base_label, label='a' + NEL + 'b'))
bad('label with U+00AD', True, with_(base_label, label='a' + SHY + 'b'))
bad('label with a zero-width joiner', True, with_(base_label, label='a' + ZWJ + 'b'))
bad('label with a newline', True, with_(base_label, label='a\nb'))
bad('label with a tab', True, with_(base_label, label='a\tb'))
bad('label record with a channel', True, with_(base_label, channel='local_db'))
bad('label record with a basis', True, with_(base_label, basis='exact'))
bad('label record with a builtin flag', True, with_(base_label, builtin=True))
bad('parser version over 30 characters', True, with_(base_label, parser_version='v' * 31))
bad('catalog name of 81 characters', True, with_(base_catalog, name='p' * 81))
bad('catalog empty name', True, with_(base_catalog, name=''))
bad('catalog name blank after trim', False, with_(base_catalog, name='  '))
bad('catalog name untrimmed', False, with_(base_catalog, name='Sample '))
bad('catalog name with U+FEFF', True, with_(base_catalog, name='Sample' + BOM))
bad('catalog name with U+2028', True, with_(base_catalog, name='Sam' + LS + 'ple'))
bad('catalog unknown app', True, with_(base_catalog, app='vscode'))
bad('catalog unknown state', True, with_(base_catalog, state='archived'))
bad('catalog negative position', True, with_(base_catalog, position=-1))
bad('catalog fractional position', True, with_(base_catalog, position=1.5))
bad('catalog position beyond a database integer', True, with_(base_catalog, position=2147483648))
bad('catalog missing position', True, with_(base_catalog, position=KeyError))
bad('catalog key not hex', True, with_(base_catalog, project_key=HN))
bad('membership named resolution without a project', False, with_(base_membership, project_key=None))
bad('membership inherited without a project', False, with_(base_membership, resolution='inherited', project_key=None))
bad('membership root prefix without a project', False, with_(base_membership, resolution='root_prefix', project_key=None))
bad('membership worktree root prefix without a project', False, with_(base_membership, resolution='worktree_root_prefix', project_key=None))
bad('membership projectless with a project', False, with_(base_membership, resolution='projectless'))
bad('membership outside roots with a project', False, with_(base_membership, resolution='outside_roots'))
bad('membership no folder with a project', False, with_(base_membership, resolution='no_folder'))
bad('membership unknown resolution', True, with_(base_membership, resolution='cross_app_root_prefix'))
bad('membership unknown member kind', True, with_(base_membership, member_kind='thread'))
bad('membership key not hex', True, with_(base_membership, member_key=HN))
bad('membership missing project key', True, with_(base_membership, project_key=KeyError))

# Section 1.6 normalization pairs: raw input, limit, expected text, expected truncation.
normalization = [
    {'raw': '  PowerShell  ', 'max': 200, 'text': 'PowerShell', 'truncated': False},
    {'raw': BOM + 'Sample' + SHY + ' Project' + LS, 'max': 80, 'text': 'Sample Project', 'truncated': False},
    {'raw': 'a' + NEL + 'b' + PS + 'c' + ZWJ + 'd', 'max': 200, 'text': 'abcd', 'truncated': False},
    {'raw': '\t\n name \r\n', 'max': 200, 'text': 'name', 'truncated': False},
    {'raw': NBSP + IDSP + 'x' + IDSP, 'max': 200, 'text': 'x', 'truncated': False},
    {'raw': 'x' * 201, 'max': 200, 'text': 'x' * 200, 'truncated': True},
    {'raw': 'x' * 199 + ' yz', 'max': 200, 'text': 'x' * 199, 'truncated': True},
    {'raw': ASTRAL * 81, 'max': 80, 'text': ASTRAL * 80, 'truncated': True},
    {'raw': CAFE, 'max': 80, 'text': CAFE, 'truncated': False},
    {'raw': '   ', 'max': 80, 'text': '', 'truncated': False},
    {'raw': BOM + LS + chr(0) + chr(0x7F), 'max': 200, 'text': '', 'truncated': False},
]

doc = {
    '_fixture': 'Synthetic side-record parity corpus (spec sections 1.3 to 1.6, tests R1 and C1). Rust (serde, Record::validate and the vendored JSON Schema) and zod must accept every valid record and reject every invalid one; schema_expressible says whether the JSON Schema alone rejects it. Generated by side_records.py in this directory; regenerate, never edit by hand.',
    'valid': [{'name': name, 'record': record} for name, record in valid],
    'invalid': invalid,
    'normalization': normalization,
}
with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    f.write(json.dumps(doc, indent=2, ensure_ascii=True) + '\n')
print(len(valid), len(invalid), len(normalization))
