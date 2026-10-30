"""Build version-checked MIT upstream copies; never edit installed node_modules."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

EXPECTED = {
    '@goodandready/dsh-messenger-gateway/lib/index.js': 'facca6f932d81ee3427ddb3ed56915a2f2500485921bfa7fc4f85f2822d8c28a',
    '@goodandready/dsh-messenger-gateway/lib/gateway.js': 'c61acedb138d714a9ce61894ff320b8faf940030266ffe314a6a9c4a59ce6935',
    'dsh-fish-memory/lib/index.js': '2b2df8b4debd2656e10653dd52caa39bc9f2df26162e55c4dcac84a05db204ae',
}

def replace_one(text, before, after):
    if text.count(before) != 1:
        raise RuntimeError('Upstream anchor is missing or ambiguous')
    return text.replace(before, after, 1)

def build(modules, output, host_modules):
    for package in ['dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-system-prompt', 'dsh-tools']:
        manifest = json.loads((host_modules / '@deepseek-ai' / package / 'package.json').read_text())
        if manifest['version'] != '0.2.2-alpha.2':
            raise RuntimeError('Unreviewed native runtime version: ' + package)
    for relative, digest in EXPECTED.items():
        if hashlib.sha256((modules / relative).read_bytes()).hexdigest() != digest:
            raise RuntimeError('Unreviewed upstream revision: ' + relative)
    if output.exists():
        raise RuntimeError('Output must be a new directory')
    output.mkdir(parents=True)
    for source, name in [('@goodandready/dsh-messenger-gateway', 'gateway'), ('dsh-fish-memory', 'fish-memory')]:
        target = output / name
        target.mkdir()
        for part in ['lib', 'package.json', 'cordis.patch.yml', 'README.md', 'README.ru.md', 'README.zh.md', 'LICENSE', 'LICENSE.md']:
            path = modules / source / part
            if path.is_dir():
                shutil.copytree(path, target / part)
            elif path.exists():
                shutil.copy2(path, target / part)
    gateway = output / 'gateway/lib/gateway.js'
    text = gateway.read_text()
    text = replace_one(text, '  async start() {\n', "  async start() {\n    this.ctx.get('zhixingCompanion')?.connect(this)\n")
    text = replace_one(text, '    const key = this.sessionKeyFor(input)\n    const body =',
        "    const key = this.sessionKeyFor(input)\n    if (await this.ctx.get('zhixingCompanion')?.beforeMessage(this, key, input)) return\n    const body =")
    text = replace_one(text, '  async createChat(key, input, existingSessionId) {\n',
        "  async createChat(key, input, existingSessionId) {\n    const companion = this.ctx.get('zhixingCompanion')\n    if (companion?.matches(input)) {\n      const cwd = resolveEffectiveCwd(this.config.agent?.cwd, this.ctx.logger)\n      const chat = await companion.openChat(this, key, input, existingSessionId, cwd)\n      await registerSessionInWorkspace(this.ctx, chat.agent.id, cwd, this.ctx.logger)\n      return chat\n    }\n")
    gateway.write_text(text)
    entry = output / 'gateway/lib/index.js'
    entry.write_text(replace_one(entry.read_text(), "export const inject = ['agentDefaultModel'", "export const inject = ['zhixingCompanion', 'agentDefaultModel'"))
    fish = output / 'fish-memory/lib/index.js'
    text = fish.read_text()
    text = replace_one(text, "export const inject = ['systemPrompt'", "export const inject = ['zhixingCompanion', 'systemPrompt'")
    text = replace_one(text, 'function storePath(sid) {\n', 'let companionMemoryScope = sid => sid\n\nfunction storePath(sid) {\n  sid = companionMemoryScope(sid)\n')
    text = replace_one(text, 'export function apply(ctx) {\n', "export function apply(ctx) {\n  companionMemoryScope = sid => ctx.get('zhixingCompanion')?.memoryId(sid) || sid\n")
    text = replace_one(text, '\n  tick()\n  // 定时器不可用时也不能让 DSH 起不来', "\n  ctx.on('agent/created', tick)\n  tick()\n  // 定时器不可用时也不能让 DSH 起不来")
    fish.write_text(text)
    # These copies contain public package assets only. The service account must
    # be able to read them even when the operator builds with a private umask.
    output.chmod(0o755)
    for path in output.rglob('*'):
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() else 0o644)
    (output / 'node_modules').symlink_to(host_modules, target_is_directory=True)
    manifest = {'sources': EXPECTED, 'modified': {str(p.relative_to(output)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [gateway, entry, fish]}, 'versions': {'gateway': '0.4.23', 'fish-memory': '1.4.3'}}
    (output / 'compat-manifest.json').write_text(json.dumps(manifest, indent=2))
    (output / 'compat-manifest.json').chmod(0o644)
    print(json.dumps(manifest, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--modules', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--host-modules', type=Path, required=True)
    args = parser.parse_args()
    build(args.modules.resolve(), args.output.resolve(), args.host_modules.resolve())
