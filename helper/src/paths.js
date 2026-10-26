// Where the helper keeps its data and looks for tools. Built from the account's real home folder,
// not the LOCALAPPDATA variable: the helper started at login once had a different LOCALAPPDATA,
// lost track of Tesseract and whisper, and would have looked for chats in the wrong place.
import os from 'node:os';
import path from 'node:path';

const home = os.userInfo().homedir;
export const LOCAL_DATA = process.platform === 'win32' ? path.join(home, 'AppData', 'Local') : path.join(home, '.cache');
export const APP_DATA = path.join(LOCAL_DATA, 'EditingAssistant');
