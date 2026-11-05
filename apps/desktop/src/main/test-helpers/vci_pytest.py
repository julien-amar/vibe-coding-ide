"""pytest plugin added by vibe-coding-ide (loaded with -p vci_pytest).

Prints, on marked lines the app reads (and hides from the output):
- with --collect-only: every collected test (node id and line);
- during a run: each test's result as soon as it finishes;
- collection errors (a file that fails to import).
"""
import json
import sys

MARK = "@@vibe-coding-ide:test "


def _emit(data):
    out = sys.__stdout__
    out.write(MARK + json.dumps(data) + "\n")
    out.flush()


def pytest_collection_finish(session):
    if not session.config.option.collectonly:
        return
    for item in session.items:
        line = item.location[1]
        _emit({"collected": item.nodeid, "line": line + 1 if isinstance(line, int) else None})


def pytest_collectreport(report):
    if report.failed:
        _emit({"collectError": report.nodeid, "message": str(report.longreprtext)})


def pytest_runtest_logreport(report):
    # One result per test: its call, or a setup that failed / was skipped, or a failing teardown.
    if not (report.when == "call" or (report.when == "setup" and not report.passed) or (report.when == "teardown" and report.failed)):
        return
    status = report.outcome
    if hasattr(report, "wasxfail"):
        # Expected failure: skipped when it failed as expected, passed when it unexpectedly passed.
        status = "skipped" if report.skipped else "passed"
    message = None
    if report.failed:
        message = str(report.longreprtext)
    elif report.skipped and isinstance(report.longrepr, tuple) and len(report.longrepr) == 3:
        message = str(report.longrepr[2])
    _emit({"nodeid": report.nodeid, "status": status, "duration": report.duration * 1000, "message": message})
