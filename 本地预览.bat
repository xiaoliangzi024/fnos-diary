@echo off
setlocal
cd /d "%~dp0"
set "NODE="
for /f "delims=" %%p in ('where node 2^>NUL') do if not defined NODE set "NODE=%%p"
if not defined NODE goto nonode
if not exist 预览数据 mkdir 预览数据
set "DATA_DIR=%CD%\预览数据\diary"
set "PORT=5001"
set "GATEWAY_PREFIX=/app/diary"
echo 正在启动本地预览，浏览器会自动打开：
echo 　　http://localhost:5001/app/diary/
echo.
echo 这个黑窗口别关，关了预览就停。
echo 你写的内容保存在本文件夹的「预览数据」里。
echo.
start "" http://localhost:5001/app/diary/
"%NODE%" diary\app\server\server.js
echo.
echo 预览已停止。
pause
exit /b 0
:nonode
echo.
echo 本机没有安装 Node.js，没法在电脑上预览。
echo 这不影响打包：直接双击「打包fpk.bat」做安装包就行。
echo.
pause
exit /b 1
