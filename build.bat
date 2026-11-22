@echo off
rem touwa-editor のフルビルドを 1 コマンドで行うスクリプト (Windows 用)。
rem 依存関係のインストール → 型チェック → テスト → 全検証 → ビルド を順に実行し、
rem 失敗したステップで即座に止まって、どのステップで落ちたかを表示する。
rem 手順は CI (.github/workflows/ci.yml) と同じ並びにする。
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm が見つかりません。Node.js 22.18 以上をインストールしてください。 1>&2
  exit /b 1
)

echo.
echo ===== 1/5 依存関係のインストール =====
if exist package-lock.json (
  call npm ci --no-audit --no-fund
) else (
  call npm install --no-audit --no-fund
)
if errorlevel 1 goto fail_install

echo.
echo ===== 2/5 型チェック (npm run typecheck) =====
call npm run typecheck
if errorlevel 1 goto fail_typecheck

echo.
echo ===== 3/5 テスト (npm test) =====
call npm test
if errorlevel 1 goto fail_test

echo.
echo ===== 4/5 全検証 (npm run verify:all) =====
call npm run verify:all
if errorlevel 1 goto fail_verify

echo.
echo ===== 5/5 ビルド (npm run build) =====
call npm run build
if errorlevel 1 goto fail_build

echo.
echo BUILD OK: touwa-editor のビルドとテストがすべて成功しました (成果物: out\)
exit /b 0

:fail_install
echo ERROR: ステップが失敗しました: 依存関係のインストール 1>&2
exit /b 1

:fail_typecheck
echo ERROR: ステップが失敗しました: 型チェック (npm run typecheck) 1>&2
exit /b 1

:fail_test
echo ERROR: ステップが失敗しました: テスト (npm test) 1>&2
exit /b 1

:fail_verify
echo ERROR: ステップが失敗しました: 全検証 (npm run verify:all) 1>&2
exit /b 1

:fail_build
echo ERROR: ステップが失敗しました: ビルド (npm run build) 1>&2
exit /b 1
