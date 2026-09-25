@echo off
rem Reabre dentro de um cmd que NAO fecha sozinho, para qualquer erro ficar visivel
if /i not "%~1"=="executar" (
  cmd /k ""%~f0" executar"
  exit /b
)
setlocal
chcp 65001 >nul
title Rota Roda - Roteirizador VRP
cd /d "%~dp0"
set "LOG=%~dp0iniciar_log.txt"
echo ==================================================
echo    Rota Roda - Roteirizador VRP (UFF)
echo ==================================================
echo.
echo [%date% %time%] Inicio > "%LOG%"

rem --- O arquivo precisa estar na pasta extraida (nao dentro do .zip) ---
if not exist "requirements.txt" (
  echo ERRO: nao encontrei os arquivos do projeto ao lado deste INICIAR.bat.
  echo Se voce abriu pelo .zip, clique com o botao direito no zip, escolha "Extrair tudo"
  echo e rode o INICIAR.bat de dentro da pasta extraida.
  echo requirements.txt ausente >> "%LOG%"
  goto fim
)

rem --- Procura o Python ---
set "PY="
py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys" >nul 2>nul && set "PY=python"
if not defined PY goto semPython
echo Python encontrado:
%PY% --version
%PY% --version >> "%LOG%" 2>&1
echo.

rem --- Instala na primeira vez (ou se a instalacao anterior nao terminou) ---
if exist ".venv\instalado.ok" goto iniciar
echo Primeira execucao: preparando o ambiente. Leva de 1 a 3 minutos, aguarde...
if exist ".venv" rmdir /s /q ".venv"
%PY% -m venv .venv >> "%LOG%" 2>&1
if errorlevel 1 goto erro
".venv\Scripts\python.exe" -m pip install --upgrade pip >> "%LOG%" 2>&1
echo Baixando bibliotecas...
".venv\Scripts\python.exe" -m pip install -r requirements.txt >> "%LOG%" 2>&1
if errorlevel 1 goto erro
echo ok > ".venv\instalado.ok"
echo Pronto!
echo.

:iniciar
echo Abrindo o app no navegador: http://localhost:8000
echo (Deixe esta janela aberta enquanto usa o app. Para encerrar, feche-a.)
echo.
start "" cmd /c "timeout /t 6 >nul & start http://localhost:8000"
".venv\Scripts\python.exe" -m uvicorn app.main:app --port 8000
echo.
echo O servidor parou. Se apareceu um erro acima, tire um print desta janela e mande para o Claude.
goto fim

:semPython
echo Nao encontrei o Python neste computador.
echo 1. Instale pelo site que vai abrir agora (versao 3.12).
echo 2. Na instalacao, MARQUE a opcao "Add python.exe to PATH".
echo 3. Feche esta janela e de dois cliques no INICIAR.bat de novo.
echo Python nao encontrado >> "%LOG%"
start "" https://www.python.org/downloads/
goto fim

:erro
echo.
echo Algo deu errado na instalacao. Os detalhes estao em iniciar_log.txt (nesta pasta).
echo Tire um print desta janela e mande para o Claude.

:fim
echo.
