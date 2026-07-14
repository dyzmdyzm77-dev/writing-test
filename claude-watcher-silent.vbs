' Claude Bridge watcher silent launcher (no window) - registered to run at login
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c node scripts\bridge-watcher.js", 0, False
