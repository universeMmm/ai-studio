#!/usr/bin/env python3
"""
Generate stub files for all TypeScript source files under src/vs/platform/agentHost/
(excluding test/ directories). Each stub re-exports the same symbols as the original
file but with empty/null implementations so the rest of the codebase can compile and
link against them at runtime.

Stub generation rules:
  - `export interface X { ... }`  →  `export interface X {}` (empty interface)
  - `export type X = ...`         →  `export type X = any`
  - `export class X { ... }`      →  `export class X { /* stub */ }`
  - `export function X(...)`      →  `export function X(...args: any[]): any { throw new Error('stub'); }`
  - `export const X = ...;`       →  `export const X: any = undefined as any;`
  - `export namespace X { ... }`  →  `export namespace X {}` (empty)
  - `export enum X { ... }`       →  `export enum X {}` (empty)
  - `export { X, Y }`             →  `export const X: any = undefined as any; export const Y: any = undefined as any;`
  - `export default ...`          →  `export default undefined as any;`
"""

import os
import re
import sys

AGENT_HOST_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'src', 'vs', 'platform', 'agentHost'
)


def read_file(path: str) -> str:
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def read_original_from_git(path: str) -> str:
    """Read the original file content from git HEAD (before our stub modifications)."""
    import subprocess
    try:
        result = subprocess.run(
            ['git', 'show', f'HEAD:{path}'],
            capture_output=True, text=True, encoding='utf-8',
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        )
        if result.returncode == 0:
            return result.stdout
    except Exception:
        pass
    # Fallback: read from disk
    return read_file(path)


def write_file(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)


def extract_exports(source: str) -> list[tuple[str, str, str]]:
    """
    Extract export declarations from TypeScript source.
    Returns list of (export_kind, name, original_signature) tuples.
    export_kind: 'interface', 'type', 'class', 'function', 'const', 'enum', 'namespace', 'default'
    """
    exports = []
    lines = source.split('\n')

    # Remove comments first (block and line comments)
    cleaned = re.sub(r'/\*.*?\*/', ' ', source, flags=re.DOTALL)
    cleaned = re.sub(r'//.*$', '', cleaned, flags=re.MULTILINE)

    # ---- Interfaces ----
    # export interface Name<...> { ... }
    for m in re.finditer(
        r'export\s+interface\s+(\w+)\s*(?:<[^>]*>)?\s*\{',
        cleaned
    ):
        exports.append(('interface', m.group(1), m.group(0)))

    # ---- Types ----
    # export type Name<...> = ...;
    for m in re.finditer(
        r'export\s+type\s+(\w+)',
        cleaned
    ):
        name = m.group(1)
        if not any(e[0] == 'type' and e[1] == name for e in exports):
            exports.append(('type', name, m.group(0)))

    # ---- Classes ----
    # export class Name<...> { ... }  or  export abstract class Name { ... }
    for m in re.finditer(
        r'export\s+(?:abstract\s+)?class\s+(\w+)',
        cleaned
    ):
        exports.append(('class', m.group(1), m.group(0)))

    # ---- Functions ----
    # export function name<...>(...) or export async function name(...)
    for m in re.finditer(
        r'export\s+(?:async\s+)?function\s+(\w+)',
        cleaned
    ):
        exports.append(('function', m.group(1), m.group(0)))

    # ---- Enums ----
    # export enum X { ... } or export const enum X { ... }
    for m in re.finditer(
        r'export\s+(?:const\s+)?enum\s+(\w+)',
        cleaned
    ):
        exports.append(('enum', m.group(1), m.group(0)))

    # ---- Namespaces ----
    # export namespace X { ... }
    for m in re.finditer(
        r'export\s+namespace\s+(\w+)',
        cleaned
    ):
        exports.append(('namespace', m.group(1), m.group(0)))

    # ---- Const/let/var ----
    # export const X = ...;  (but NOT export const enum which is handled above)
    for m in re.finditer(
        r'export\s+(?:const|let|var)\s+(?!enum\b)(\w+)',
        cleaned
    ):
        name = m.group(1)
        if not any(e[1] == name for e in exports):
            exports.append(('const', name, m.group(0)))

    # ---- Named re-exports ----
    # export { X, Y }  or  export { X as Y }
    for m in re.finditer(
        r'export\s*\{\s*([^}]+)\}',
        cleaned
    ):
        names_str = m.group(1)
        for part in names_str.split(','):
            part = part.strip()
            as_match = re.match(r'(\w+)\s+as\s+(\w+)', part)
            if as_match:
                name = as_match.group(2)
            else:
                name = part
            if name and not any(e[1] == name for e in exports):
                exports.append(('const', name, f'export const {name}'))

    # ---- Default exports ----
    if re.search(r'export\s+default\s+', cleaned):
        exports.append(('default', 'default', 'export default'))

    return exports


def extract_barrel_exports(source: str) -> list[str]:
    """Extract `export * from '...'` and `export { X } from '...'` lines."""
    barrels = []
    for line in source.split('\n'):
        stripped = line.strip()
        if re.match(r'export\s+\*\s+from\s+', stripped):
            barrels.append(stripped)
        elif re.match(r'export\s+\{[^}]*\}\s*from\s+', stripped):
            barrels.append(stripped)
    return barrels


def generate_stub(original_path: str, exports: list[tuple[str, str, str]], rel_path: str, source: str) -> str:
    """
    Generate a stub TypeScript module that exports all the same symbols
    with dummy implementations.
    """
    lines = []
    lines.append('/*---------------------------------------------------------------------------------------------')
    lines.append(' *  Copyright (c) Microsoft Corporation. All rights reserved.')
    lines.append(' *  Licensed under the MIT License. See License.txt in the project root for license information.')
    lines.append(' *--------------------------------------------------------------------------------------------*/')
    lines.append('')
    lines.append('// STUB — agentHost 已剥离，此文件为占位桩模块')
    lines.append('')

    # Group exports by kind
    interfaces = []
    types = []
    classes = []
    functions = []
    consts = []
    enums = []
    namespaces = []
    has_default = False

    for kind, name, _sig in exports:
        if kind == 'interface':
            interfaces.append(name)
        elif kind == 'type':
            types.append(name)
        elif kind == 'class':
            classes.append(name)
        elif kind == 'function':
            functions.append(name)
        elif kind == 'const':
            consts.append(name)
        elif kind == 'enum':
            enums.append(name)
        elif kind == 'namespace':
            namespaces.append(name)
        elif kind == 'default':
            has_default = True

    # Generate interfaces (as any types to avoid cascading type errors)
    for name in interfaces:
        lines.append('')
        lines.append(f'export type {name} = any;')

    # Generate types
    for name in types:
        lines.append('')
        lines.append(f'export type {name} = any;')

    # Generate classes
    for name in classes:
        lines.append('')
        lines.append(f'export class {name} {{')
        lines.append(f'\t// STUB: agentHost 已剥离')
        lines.append(f'}}')

    # Generate functions
    for name in functions:
        lines.append('')
        lines.append(f'export function {name}(..._args: any[]): any {{')
        lines.append(f'\tthrow new Error(\'agentHost stub: {name} is not available\');')
        lines.append(f'}}')

    # Generate consts
    for name in consts:
        lines.append('')
        lines.append(f'export const {name}: any = undefined as any;')

    # Generate enums
    for name in enums:
        lines.append('')
        lines.append(f'export enum {name} {{}}')

    # Generate namespaces
    for name in namespaces:
        lines.append('')
        lines.append(f'export namespace {name} {{}}')

    if has_default:
        lines.append('')
        lines.append('export default undefined as any;')

    # If no direct exports, add a token export for compilation
    has_exports = bool(interfaces or types or classes or functions or consts or enums or namespaces or has_default)

    if not has_exports:
        lines.append('')
        lines.append('export {};')

    lines.append('')
    return '\n'.join(lines)


def should_skip_file(path: str) -> bool:
    """Skip test files, declaration files, and non-TypeScript files."""
    basename = os.path.basename(path)
    if basename.endswith('.d.ts'):
        return True
    if not basename.endswith('.ts'):
        return True
    # Skip test directory
    if os.sep + 'test' + os.sep in path:
        return True
    return False


def main():
    generated = 0
    skipped = 0
    errors = []

    for root, dirs, files in os.walk(AGENT_HOST_DIR):
        # Skip test directories
        if os.sep + 'test' in root:
            continue

        for fname in files:
            filepath = os.path.join(root, fname)
            if should_skip_file(filepath):
                continue

            rel = os.path.relpath(filepath, AGENT_HOST_DIR)

            try:
                source = read_file(filepath)
                # Read original from git for barrel export detection
                # (file may have been overwritten by a previous stub run)
                git_rel_path = os.path.relpath(filepath, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
                git_rel_path = git_rel_path.replace('\\', '/')
                original_source = read_original_from_git(git_rel_path)
                if original_source == source:
                    # File hasn't been stubbed yet, use as-is
                    original_source = source
                exports = extract_exports(source)
                stub = generate_stub(filepath, exports, rel, original_source)
                write_file(filepath, stub)
                print(f'  OK {rel} ({len(exports)} exports)')
                generated += 1
            except Exception as e:
                print(f'  ERR {rel}: {e}')
                errors.append((rel, str(e)))

    print(f'\n--- Done ---')
    print(f'Generated: {generated} stubs')
    if errors:
        print(f'Errors: {len(errors)}')
        for fname, err in errors:
            print(f'  ERR {fname}: {err}')
    else:
        print('No errors!')


if __name__ == '__main__':
    main()
