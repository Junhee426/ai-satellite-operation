"""Runs the JS-side regression tests for static/app.js (tests/js/*.test.mjs)
as part of the Python test suite.

app.js is a plain browser script (no bundler/module system, no existing JS
test runner in this repo), so these regressions - which exercise app.js's
`init()` and `request()` directly in a Node vm sandbox - live under
tests/js/ and run via Node's built-in test runner (`node --test`, no extra
npm dependencies required; Node 18+ ships it). This wrapper just shells out
to that runner so `pytest -q` (and CI) picks them up too.

They cover the review-follow-up fixes to static/app.js:
- init(): a failed/malformed /static/world.json must not prevent the
  catalog and telemetry/experiment/export functionality from working
  (tests/js/map-failure.test.mjs).
- request(): the AbortController timeout must stay armed through response
  body parsing, and busy UI state must always be restored afterward
  (tests/js/request-timeout.test.mjs).

Skipped (not failed) if Node.js isn't available in this environment.
"""
import shutil
import subprocess
import sys

import pytest

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
JS_TEST_GLOB_DIR = REPO_ROOT / 'tests' / 'js'


@pytest.mark.skipif(shutil.which('node') is None, reason='Node.js is not available in this environment')
def test_app_js_regressions_pass():
    test_files = sorted(str(p) for p in JS_TEST_GLOB_DIR.glob('*.test.mjs'))
    assert test_files, f'no *.test.mjs files found under {JS_TEST_GLOB_DIR}'

    result = subprocess.run(
        ['node', '--test', *test_files],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        env={**__import__('os').environ, 'PYTHON_BIN': sys.executable},
    )

    assert result.returncode == 0, (
        'JS regression tests (tests/js/*.test.mjs) failed:\n\n'
        f'--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}'
    )
