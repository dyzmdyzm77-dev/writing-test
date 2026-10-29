' Claude Bridge watcher silent launcher (no window) - registered to run at login
' Uses the bundled runtime\node.exe when present (distribution zip), otherwise the PC's node.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
nodeExe = "node"
If fso.FileExists(dir & "\runtime\node.exe") Then nodeExe = """" & dir & "\runtime\node.exe"""
sh.Run "cmd /c " & nodeExe & " scripts\bridge-watcher.js", 0, False