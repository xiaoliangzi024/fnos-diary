@echo off
setlocal
cd /d "%~dp0"
echo [1/3] 正在打包...
tools\fnpack.exe build --directory diary
if errorlevel 1 goto fail

echo [2/3] 正在修补脚本执行权限，Windows 上打包必须做这一步...
set "PY="
for /f "delims=" %%p in ('where python 2^>NUL') do if not defined PY set "PY=%%p"
if not defined PY for /f "delims=" %%p in ('where py 2^>NUL') do if not defined PY set "PY=%%p"
if defined PY (
  "%PY%" "%~dp0tools\fix_fpk_perms.py" diary.fpk
  if errorlevel 1 goto permfail
) else (
  echo 　！找不到 Python，这一步没能执行。
  echo 　！请去 python.org 装一个 Python 3 后重新打包。
  goto noperm
)

echo [3/3] 正在核验包内脚本权限...
"%PY%" "%~dp0tools\check_fpk.py" diary.fpk
if errorlevel 1 goto permfail

echo.
echo ＝＝ 完成！安装包已就绪：diary.fpk ＝＝
echo 把它拷到飞牛，在应用中心点「手动安装」选中即可。
echo.
pause
exit /b 0

:permfail
echo.
echo ＝＝ 打包出来了，但脚本权限没修好 ＝＝
echo 直接安装可能提示启动失败。请截图发给我的那一行提示。
echo.
pause
exit /b 1

:noperm
echo.
echo ＝＝ 请装 Python 后重新打包 ＝＝
echo 现在这个 diary.fpk 权限不对，先别装到飞牛。
echo.
pause
exit /b 1

:fail
echo.
echo ＝＝ 打包失败 ＝＝
echo 请把上面几行提示拍下来发给我。
echo.
pause
exit /b 1
