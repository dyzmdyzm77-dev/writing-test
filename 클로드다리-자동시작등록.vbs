' Register Claude Bridge to auto-start at login (silent).
' To undo: Win+R -> shell:startup -> delete ClaudeBridge shortcut.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
startup = sh.SpecialFolders("Startup")
Set lnk = sh.CreateShortcut(startup & "\ClaudeBridge.lnk")
lnk.TargetPath = dir & "\claude-bridge-silent.vbs"
lnk.WorkingDirectory = dir
lnk.Save
MsgBox "OK - Claude Bridge will start automatically at login." & vbCrLf & "Undo: Win+R -> shell:startup -> delete ClaudeBridge", 64, "Claude Bridge"
