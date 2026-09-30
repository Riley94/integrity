"""Unit tests for prediction rows and smoke-run status classification."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from swebench.harness import (
    MODEL_NAME_OR_PATH,
    classify_status,
    load_instance_ids,
    outcome_row,
    prediction_row,
    prompt_is_outside_repo,
    select_smoke_instance_ids,
    smoke_profile_settings,
    task_layout,
    upsert_jsonl,
    window_argv,
)


class PredictionRowTest(unittest.TestCase):
    def test_shape(self) -> None:
        row = prediction_row('astropy__astropy-12907', 'diff --git a/a.py b/a.py\n')
        self.assertEqual(set(row), {'instance_id', 'model_name_or_path', 'model_patch'})
        self.assertEqual(row['instance_id'], 'astropy__astropy-12907')
        self.assertEqual(row['model_name_or_path'], MODEL_NAME_OR_PATH)
        self.assertTrue(row['model_patch'].startswith('diff --git'))

    def test_empty_patch_is_kept(self) -> None:
        row = prediction_row('psf__requests-1724', '')
        self.assertEqual(row['model_patch'], '')
        outcome = outcome_row('psf__requests-1724', 'completed', 1.5, True)
        self.assertTrue(outcome['patch_empty'])
        self.assertEqual(outcome['outcome'], 'completed')


class StatusOutcomeTest(unittest.TestCase):
    def test_completed_and_error(self) -> None:
        self.assertEqual(classify_status({'outcome': 'completed'}), 'completed')
        self.assertEqual(classify_status({'outcome': 'error', 'message': 'no model'}), 'error')

    def test_missing_file_is_timeout(self) -> None:
        self.assertEqual(classify_status(None), 'timeout')

    def test_unknown_outcome_is_error(self) -> None:
        self.assertEqual(classify_status({'outcome': 'quit'}), 'error')


class LayoutTest(unittest.TestCase):
    def test_prompt_sits_outside_the_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            layout = task_layout(run_dir, 'sympy__sympy-20590')
            self.assertTrue(prompt_is_outside_repo(layout['prompt'], layout['repo']))
            self.assertTrue(prompt_is_outside_repo(layout['status'], layout['repo']))
            self.assertEqual(layout['prompt'].parent, layout['repo'].parent)


class InstanceSelectionTest(unittest.TestCase):
    def test_round_robin_across_preferred_repos(self) -> None:
        rows = []
        for repo, names in {
            'astropy/astropy': ['astropy__astropy-2', 'astropy__astropy-1'],
            'psf/requests': ['psf__requests-2', 'psf__requests-1'],
            'pydata/xarray': ['pydata__xarray-1'],
            'pylint-dev/pylint': ['pylint-dev__pylint-1'],
            'sphinx-doc/sphinx': ['sphinx-doc__sphinx-1'],
            'sympy/sympy': ['sympy__sympy-1'],
            'django/django': ['django__django-1'],
        }.items():
            for instance_id in names:
                rows.append({'repo': repo, 'instance_id': instance_id})
        selected = select_smoke_instance_ids(rows, count=8)
        self.assertEqual(selected, [
            'astropy__astropy-1',
            'psf__requests-1',
            'pydata__xarray-1',
            'pylint-dev__pylint-1',
            'sphinx-doc__sphinx-1',
            'sympy__sympy-1',
            'astropy__astropy-2',
            'psf__requests-2',
        ])
        self.assertNotIn('django__django-1', selected)

    def test_load_instance_ids_rejects_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'instances.json'
            path.write_text(json.dumps({'instance_ids': ['a', 'a']}), encoding='utf-8')
            with self.assertRaises(ValueError):
                load_instance_ids(path)


class LaunchTest(unittest.TestCase):
    def test_skips_the_first_launch_sign_in_overlay(self) -> None:
        settings = smoke_profile_settings('secret', 'ollama:qwen2.5-coder:14b')
        self.assertFalse(settings['workbench.welcomePage.experimentalOnboarding'])
        self.assertEqual(settings['workbench.startupEditor'], 'none')
        command = window_argv(Path('/repo'), Path('/task'), Path('/profile'))
        self.assertIn('--skip-welcome', command)
        self.assertEqual(command[0], '/repo')
        self.assertEqual(command[-1], '/task')


class JsonlTest(unittest.TestCase):
    def test_upsert_replaces_an_instance_and_keeps_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'preds.jsonl'
            upsert_jsonl(path, [prediction_row('a', 'one')], ['a', 'b'])
            upsert_jsonl(path, [prediction_row('b', ''), prediction_row('a', 'two')], ['a', 'b'])
            rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
            self.assertEqual([row['instance_id'] for row in rows], ['a', 'b'])
            self.assertEqual(rows[0]['model_patch'], 'two')
            self.assertEqual(rows[1]['model_patch'], '')


if __name__ == '__main__':
    unittest.main()
