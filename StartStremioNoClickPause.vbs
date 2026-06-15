Option Explicit

Dim sh
Set sh = CreateObject("WScript.Shell")

Dim webDir
Dim stremioExe
Dim webuiUrl

webDir = "D:\stremio-web"
stremioExe = "C:\Users\meteh\AppData\Local\Programs\Stremio\stremio-shell-ng.exe"
webuiUrl = "http://127.0.0.1:7777/#/"

' Close old instances
sh.Run "taskkill /IM stremio-shell-ng.exe /F", 0, True
sh.Run "taskkill /IM stremio-runtime.exe /F", 0, True
sh.Run "taskkill /IM msedgewebview2.exe /F", 0, True
' sh.Run "taskkill /IM node.exe /F", 0, True

' Let custom local Web UI talk to Stremio runtime
sh.Environment("PROCESS")("NO_CORS") = "1"

' Start patched Stremio Web hidden
sh.Run "cmd /c ""cd /d " & webDir & " && serve -s build -l 7777""", 0, False

' Wait for local web server
WScript.Sleep 0000

' Start Stremio normally
sh.Run """" & stremioExe & """ --webui-url=" & webuiUrl, 1, False