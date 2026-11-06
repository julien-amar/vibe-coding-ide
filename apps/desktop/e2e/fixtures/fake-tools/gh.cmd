@SETLOCAL
@SET "dp0=%~dp0"
@REM Same layout as npm's command shims: vibe-coding-ide launches the script directly.
@node "%dp0%\fake-gh.cjs" %*
