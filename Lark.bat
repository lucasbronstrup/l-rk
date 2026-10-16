@echo off
rem Lärk — duplo clique para iniciar no Windows.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  O Lärk precisa do Node.js 20 ou mais novo.
  echo  Baixe e instale em https://nodejs.org e depois abra este atalho de novo.
  echo.
  pause
  exit /b 1
)
title Lärk
node scripts\lark.mjs %*
if errorlevel 1 pause
