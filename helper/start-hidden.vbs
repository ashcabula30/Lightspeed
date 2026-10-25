' Starts the Editing Assistant helper with no window; output goes to helper.log next to this file.
' Used by the login shortcut that install-autostart.cmd creates.
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd /c node src\server.js > helper.log 2>&1", 0, False
