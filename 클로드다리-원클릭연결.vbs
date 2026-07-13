' Register the claudebridge:// URL so the Figma plugin's button can start the bridge.
' Run once per PC (no admin rights needed). Undo: delete HKCU\Software\Classes\claudebridge
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "wscript.exe """ & dir & "\claude-bridge-silent.vbs"""
sh.RegWrite "HKCU\Software\Classes\claudebridge\", "URL:Claude Bridge", "REG_SZ"
sh.RegWrite "HKCU\Software\Classes\claudebridge\URL Protocol", "", "REG_SZ"
sh.RegWrite "HKCU\Software\Classes\claudebridge\shell\open\command\", cmd, "REG_SZ"
MsgBox "OK - The plugin's Claude button can now start the bridge on this PC.", 64, "Claude Bridge"
