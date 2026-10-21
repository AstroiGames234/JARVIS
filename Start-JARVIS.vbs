Option Explicit
Dim shell, fso, folder, command, nodeExe, runtimePath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & folder & "\Stop-JARVIS.ps1" & Chr(34) & " -Quiet"
shell.Run command, 0, True
runtimePath = shell.ExpandEnvironmentStrings("%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
If fso.FileExists(runtimePath) Then
  nodeExe = runtimePath
Else
  nodeExe = "node.exe"
End If
command = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & folder & "\server.js" & Chr(34)
shell.Run command, 0, False
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File " & Chr(34) & folder & "\Background-Tray.ps1" & Chr(34)
shell.Run command, 0, False
