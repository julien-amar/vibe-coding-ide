@SETLOCAL
@SET "dp0=%~dp0"
@REM Same layout as npm's command shims: (a stand-in: see fake-kube.cjs)
@node "%dp0%\fake-kube.cjs" kubectl %*
