' ClipShare — lanza el servidor sin ventana CMD visible
' Doble-clic para iniciar. El proceso corre en background.
' Para detenerlo: ejecuta stop.bat

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\tmp-clipshare && node server.js >> C:\tmp-clipshare\server.log 2>&1", 0, False

MsgBox "ClipShare iniciado en http://localhost:9977" & Chr(13) & "PIN: 1stbrain" & Chr(13) & Chr(13) & "Para detenerlo ejecuta stop.bat", 64, "ioiClipShare"
