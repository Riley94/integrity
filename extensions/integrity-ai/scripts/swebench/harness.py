"""Prepare, run, and score a SWE-bench Verified smoke set against the Integrity agent.

Prerequisites:
  - A built workbench (`node build/lib/preLaunch.ts` from the repo root, or let `run` do it).
  - Ollama already serving `qwen2.5-coder:14b` and `nomic-embed-text`.
  - `INTEGRITY_JEV_API_KEY` for `run`.
  - Docker and `pip install swebench` only for `eval`.
  - A display. If `DISPLAY` is unset, run under `xvfb-run`.

From `extensions/integrity-ai/scripts`:

  python -m swebench prepare
  python -m swebench run
  python -m swebench eval
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

DATASET_NAME = 'princeton-nlp/SWE-bench_Verified'
MODEL_NAME_OR_PATH = 'integrity-ollama-qwen2.5-coder-14b'
DEFAULT_MODEL_ID = 'ollama:qwen2.5-coder:14b'
DEFAULT_TIMEOUT_MINUTES = 45
SMOKE_COUNT = 8

# Smaller Verified repos. django is intentionally absent.
PREFERRED_REPOS = (
    'astropy/astropy',
    'psf/requests',
    'pydata/xarray',
    'pylint-dev/pylint',
    'sphinx-doc/sphinx',
    'sympy/sympy',
)

SWEBENCH_ENV = 'INTEGRITY_SWEBENCH'
SWEBENCH_PROMPT_FILE_ENV = 'INTEGRITY_SWEBENCH_PROMPT_FILE'
SWEBENCH_STATUS_FILE_ENV = 'INTEGRITY_SWEBENCH_STATUS_FILE'
SWEBENCH_MODEL_ENV = 'INTEGRITY_SWEBENCH_MODEL'
JEV_API_KEY_ENV = 'INTEGRITY_JEV_API_KEY'

PACKAGE_DIR = Path(__file__).resolve().parent
DEFAULT_INSTANCES = PACKAGE_DIR / 'instances.json'
DEFAULT_RUN_DIR = PACKAGE_DIR / 'runs'


def select_smoke_instance_ids(rows: list[dict[str, str]], count: int = SMOKE_COUNT) -> list[str]:
    """Pick a frozen-style smoke set by round-robin across the preferred repos.

    Repos and instance ids are sorted so the same dataset always yields the same ids.
    """
    grouped: dict[str, list[str]] = {repo: [] for repo in PREFERRED_REPOS}
    for row in rows:
        repo = row.get('repo', '')
        instance_id = row.get('instance_id', '')
        if repo in grouped and instance_id:
            grouped[repo].append(instance_id)
    for repo in grouped:
        grouped[repo] = sorted(set(grouped[repo]))

    selected: list[str] = []
    round_index = 0
    while len(selected) < count:
        added = False
        for repo in PREFERRED_REPOS:
            ids = grouped[repo]
            if round_index < len(ids):
                selected.append(ids[round_index])
                added = True
                if len(selected) == count:
                    return selected
        if not added:
            raise ValueError(f'Only found {len(selected)} smoke instances; needed {count}.')
        round_index += 1
    return selected


def load_instance_ids(path: Path) -> list[str]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    ids = payload.get('instance_ids')
    if not isinstance(ids, list) or not ids or not all(isinstance(item, str) and item for item in ids):
        raise ValueError(f'{path} must contain a non-empty instance_ids list of strings.')
    if len(ids) != len(set(ids)):
        raise ValueError(f'{path} contains duplicate instance ids.')
    return ids


def task_layout(run_dir: Path, instance_id: str) -> dict[str, Path]:
    """Paths for one instance. The prompt and status files sit beside the repo, not inside it."""
    root = run_dir / instance_id
    return {
        'root': root,
        'repo': root / 'repo',
        'prompt': root / 'prompt.md',
        'status': root / 'status.json',
        'profile': root / 'profile',
    }


def prompt_is_outside_repo(prompt: Path, repo: Path) -> bool:
    prompt_resolved = prompt.resolve()
    repo_resolved = repo.resolve()
    return prompt_resolved != repo_resolved and repo_resolved not in prompt_resolved.parents


def prediction_row(instance_id: str, model_patch: str, model_name: str = MODEL_NAME_OR_PATH) -> dict[str, str]:
    return {
        'instance_id': instance_id,
        'model_name_or_path': model_name,
        'model_patch': model_patch,
    }


def outcome_row(
    instance_id: str,
    outcome: str,
    elapsed_s: float,
    patch_empty: bool,
    message: str | None = None,
) -> dict[str, object]:
    row: dict[str, object] = {
        'instance_id': instance_id,
        'outcome': outcome,
        'elapsed_s': elapsed_s,
        'patch_empty': patch_empty,
    }
    if message:
        row['message'] = message
    return row


def classify_status(payload: dict[str, object] | None) -> str:
    """Map a status file to completed, error, or timeout when the file never appeared."""
    if payload is None:
        return 'timeout'
    outcome = payload.get('outcome')
    if outcome in ('completed', 'error'):
        return str(outcome)
    return 'error'


def read_status(path: Path) -> dict[str, object] | None:
    if not path.is_file():
        return None
    parsed = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(parsed, dict):
        raise ValueError(f'{path} is not a JSON object.')
    return parsed


def upsert_jsonl(path: Path, rows: list[dict[str, object]], order: list[str]) -> None:
    """Rewrite a jsonl, replacing rows for the given instance ids and keeping that order."""
    by_id: dict[str, dict[str, object]] = {}
    if path.is_file():
        for line in path.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if isinstance(row, dict) and isinstance(row.get('instance_id'), str):
                by_id[row['instance_id']] = row
    for row in rows:
        instance_id = row.get('instance_id')
        if isinstance(instance_id, str):
            by_id[instance_id] = row
    ordered = [by_id[instance_id] for instance_id in order if instance_id in by_id]
    leftovers = [row for instance_id, row in by_id.items() if instance_id not in order]
    path.parent.mkdir(parents=True, exist_ok=True)
    body = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in [*ordered, *leftovers])
    path.write_text(body, encoding='utf-8')


def repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / 'product.json').is_file() and (parent / 'scripts' / 'code.sh').is_file():
            return parent
    raise RuntimeError('Could not find the Integrity repo root (product.json).')


def electron_binary(root: Path) -> Path:
    product = json.loads((root / 'product.json').read_text(encoding='utf-8'))
    name = product['applicationName']
    return root / '.build' / 'electron' / name


def ollama_chat_model(model_id: str) -> str:
    prefix = 'ollama:'
    if model_id.startswith(prefix):
        return model_id[len(prefix):]
    return model_id


def load_dataset_rows() -> list[dict[str, str]]:
    try:
        from datasets import load_dataset
    except ImportError as err:
        raise RuntimeError('prepare needs the datasets package: pip install datasets') from err
    dataset = load_dataset(DATASET_NAME, split='test')
    rows: list[dict[str, str]] = []
    for record in dataset:
        rows.append({
            'instance_id': str(record['instance_id']),
            'repo': str(record['repo']),
            'base_commit': str(record['base_commit']),
            'problem_statement': str(record['problem_statement']),
        })
    return rows


def checkout_instance(repo_dir: Path, repo: str, base_commit: str) -> None:
    repo_dir.parent.mkdir(parents=True, exist_ok=True)
    if not (repo_dir / '.git').is_dir():
        subprocess.run(
            ['git', 'clone', '--quiet', f'https://github.com/{repo}.git', str(repo_dir)],
            check=True,
        )
    subprocess.run(['git', 'checkout', '--force', base_commit], cwd=repo_dir, check=True)
    subprocess.run(['git', 'reset', '--hard', base_commit], cwd=repo_dir, check=True)
    subprocess.run(['git', 'clean', '-fd'], cwd=repo_dir, check=True)


def capture_patch(repo_dir: Path) -> str:
    """Include new files. `git add -N` only updates the index so the worktree stays as the agent left it."""
    subprocess.run(['git', 'add', '-N', '--', '.'], cwd=repo_dir, check=True)
    result = subprocess.run(
        ['git', 'diff', '--binary', 'HEAD'],
        cwd=repo_dir,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def smoke_profile_settings(api_key: str, model_id: str) -> dict[str, object]:
    """Throwaway profile settings.

    A fresh user-data dir is a new application, and the default first-launch
    experience is the Sign In onboarding overlay. That overlay blocks the
    unattended smoke run, so it stays off here.
    """
    return {
        'security.workspace.trust.enabled': False,
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
        'workbench.startupEditor': 'none',
        'workbench.welcomePage.experimentalOnboarding': False,
        'integrity.ai.defaultProvider': 'ollama',
        'integrity.ai.ollama.chatModel': ollama_chat_model(model_id),
        'integrity.ai.ollama.embeddingModel': 'nomic-embed-text',
        'integrity.ai.jev.apiKey': api_key,
    }


def write_profile(profile: Path, api_key: str, model_id: str) -> None:
    user_dir = profile / 'User'
    user_dir.mkdir(parents=True, exist_ok=True)
    settings = smoke_profile_settings(api_key, model_id)
    (user_dir / 'settings.json').write_text(json.dumps(settings, indent=2) + '\n', encoding='utf-8')


def window_argv(app_root: Path, task_repo: Path, profile: Path) -> list[str]:
    """Arguments after the Electron binary.

    Dev mode strips the first positional as the app root, so that must be
    `app_root` and the task repo must come later. `--skip-welcome` keeps the
    first-launch Sign In overlay from covering the window.
    """
    return [
        str(app_root),
        '--disable-extension=vscode.vscode-api-tests',
        '--disable-workspace-trust',
        '--skip-welcome',
        f'--user-data-dir={profile}',
        str(task_repo),
    ]


def launch_command(root: Path, task_repo: Path, profile: Path) -> list[str]:
    return [str(electron_binary(root)), *window_argv(root, task_repo, profile)]


def window_env(prompt: Path, status: Path, model_id: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update({
        'NODE_ENV': 'development',
        'VSCODE_DEV': '1',
        'VSCODE_CLI': '1',
        'ELECTRON_ENABLE_STACK_DUMPING': '1',
        'ELECTRON_ENABLE_LOGGING': '1',
        SWEBENCH_ENV: '1',
        SWEBENCH_PROMPT_FILE_ENV: str(prompt),
        SWEBENCH_STATUS_FILE_ENV: str(status),
        SWEBENCH_MODEL_ENV: model_id,
    })
    return env


def run_prelaunch(root: Path) -> None:
    if os.environ.get('VSCODE_SKIP_PRELAUNCH'):
        return
    subprocess.run(['node', 'build/lib/preLaunch.ts'], cwd=root, check=True)


def require_display() -> None:
    if not os.environ.get('DISPLAY'):
        raise RuntimeError('DISPLAY is unset. Re-run under xvfb-run so the workbench has a display.')


def _kill_process_group(pid: int, sig: signal.Signals) -> None:
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        return


def wait_for_window(proc: subprocess.Popen[bytes], timeout_s: float) -> int | None:
    """Return the exit code, or None when the timeout kills the process group."""
    try:
        return proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        _kill_process_group(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            _kill_process_group(proc.pid, signal.SIGKILL)
            proc.wait()
        return None


def prepare(run_dir: Path, instances_path: Path) -> None:
    instance_ids = load_instance_ids(instances_path)
    rows = {row['instance_id']: row for row in load_dataset_rows()}
    missing = [instance_id for instance_id in instance_ids if instance_id not in rows]
    if missing:
        raise RuntimeError(f'Instance ids missing from {DATASET_NAME}: {", ".join(missing)}')
    for instance_id in instance_ids:
        row = rows[instance_id]
        layout = task_layout(run_dir, instance_id)
        if not prompt_is_outside_repo(layout['prompt'], layout['repo']):
            raise RuntimeError(f'Prompt path for {instance_id} is inside the task repo.')
        checkout_instance(layout['repo'], row['repo'], row['base_commit'])
        layout['prompt'].parent.mkdir(parents=True, exist_ok=True)
        layout['prompt'].write_text(row['problem_statement'], encoding='utf-8')
        if layout['status'].exists():
            layout['status'].unlink()
        print(f'prepared {instance_id}')


def run_instances(run_dir: Path, instances_path: Path, timeout_minutes: float, model_id: str) -> None:
    require_display()
    api_key = os.environ.get(JEV_API_KEY_ENV, '')
    if not api_key:
        raise RuntimeError(f'{JEV_API_KEY_ENV} is required so Jev can answer during the smoke run.')
    root = repo_root()
    binary = electron_binary(root)
    if not binary.is_file():
        raise RuntimeError(f'Workbench binary not found at {binary}. Build the workbench first.')
    run_prelaunch(root)
    instance_ids = load_instance_ids(instances_path)
    preds_path = run_dir / 'preds.jsonl'
    outcomes_path = run_dir / 'outcomes.jsonl'
    timeout_s = timeout_minutes * 60
    for instance_id in instance_ids:
        layout = task_layout(run_dir, instance_id)
        if not (layout['repo'] / '.git').is_dir():
            raise RuntimeError(f'{instance_id} is not prepared. Run prepare first.')
        if layout['status'].exists():
            layout['status'].unlink()
        write_profile(layout['profile'], api_key, model_id)
        started = time.monotonic()
        proc = subprocess.Popen(
            launch_command(root, layout['repo'], layout['profile']),
            cwd=root,
            env=window_env(layout['prompt'], layout['status'], model_id),
            start_new_session=True,
        )
        exit_code = wait_for_window(proc, timeout_s)
        elapsed = time.monotonic() - started
        status = read_status(layout['status'])
        outcome = classify_status(status)
        message = None
        if isinstance(status, dict) and isinstance(status.get('message'), str):
            message = status['message']
        elif exit_code is None:
            message = f'timed out after {timeout_minutes:g} minutes'
        elif outcome == 'timeout':
            message = f'window exited ({exit_code}) before writing a status file'
        try:
            patch = capture_patch(layout['repo'])
        except subprocess.CalledProcessError as err:
            patch = ''
            outcome = 'error'
            message = f'failed to capture git diff: {err}'
        upsert_jsonl(preds_path, [prediction_row(instance_id, patch)], instance_ids)
        upsert_jsonl(outcomes_path, [outcome_row(
            instance_id,
            outcome,
            round(elapsed, 3),
            patch.strip() == '',
            message,
        )], instance_ids)
        print(f'{instance_id}: {outcome} empty={patch.strip() == ""}')


def evaluate(run_dir: Path, instances_path: Path, max_workers: int, run_id: str) -> None:
    preds = run_dir / 'preds.jsonl'
    if not preds.is_file():
        raise RuntimeError(f'No predictions at {preds}. Run the smoke set first.')
    instance_ids = load_instance_ids(instances_path)
    command = [
        sys.executable,
        '-m',
        'swebench.harness.run_evaluation',
        '--dataset_name',
        DATASET_NAME,
        '--predictions_path',
        str(preds),
        '--max_workers',
        str(max_workers),
        '--run_id',
        run_id,
        '--instance_ids',
        *instance_ids,
    ]
    subprocess.run(command, check=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='python -m swebench',
        description=(
            'SWE-bench Verified smoke harness for the Integrity agent. '
            'Requires a built workbench, Ollama serving qwen2.5-coder:14b and '
            'nomic-embed-text, and INTEGRITY_JEV_API_KEY for run. '
            'prepare also needs: pip install datasets. '
            'Docker and pip install swebench are required only for eval. '
            'If DISPLAY is unset, use xvfb-run.'
        ),
    )
    parser.add_argument('--run-dir', type=Path, default=DEFAULT_RUN_DIR, help='Worktrees, prompts, and prediction files.')
    parser.add_argument('--instances', type=Path, default=DEFAULT_INSTANCES, help='Pinned instance id list.')
    sub = parser.add_subparsers(dest='command', required=True)

    sub.add_parser('prepare', help='Clone each pinned instance at base_commit and write its problem statement.')

    run_parser = sub.add_parser('run', help='Open one workbench per instance and record model patches.')
    run_parser.add_argument('--timeout-minutes', type=float, default=DEFAULT_TIMEOUT_MINUTES)
    run_parser.add_argument('--model-id', default=DEFAULT_MODEL_ID)

    eval_parser = sub.add_parser('eval', help='Score preds.jsonl with the official SWE-bench Docker harness.')
    eval_parser.add_argument('--max-workers', type=int, default=2)
    eval_parser.add_argument('--run-id', default='integrity-smoke')
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    run_dir = args.run_dir.resolve()
    instances = args.instances.resolve()
    try:
        if args.command == 'prepare':
            prepare(run_dir, instances)
        elif args.command == 'run':
            run_instances(run_dir, instances, args.timeout_minutes, args.model_id)
        elif args.command == 'eval':
            evaluate(run_dir, instances, args.max_workers, args.run_id)
        else:
            parser.error(f'unknown command {args.command}')
    except (RuntimeError, ValueError, subprocess.CalledProcessError) as err:
        print(err, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
