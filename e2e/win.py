"""Windows helpers for e2e/real-app.mjs.

  python e2e/win.py hotkey                       press Ctrl+Shift+Space (SendInput)
  python e2e/win.py clipboard                    print {"text": <clipboard text or null>}
  python e2e/win.py fill-dialog PID TITLE PATH   type PATH into the open-file dialog
                                                 TITLE of process PID and press Open
  python e2e/win.py contact-sheet OUT IMG...     tile screenshots into one PNG
  python e2e/win.py monitors                     print each monitor: work area, scale
  python e2e/win.py focus-at X Y SECONDS         open a window at X, Y (physical px),
                                                 bring it to the front, press the hotkey
  python e2e/win.py ctrl-wheel PID NOTCHES       Ctrl + mouse wheel over the visible
                                                 Quick Access of process PID (a zoom gesture)

fill-dialog sends window messages to that one dialog: it never types into
whatever window has the keyboard focus. hotkey is safe only while Coffer has
the hotkey registered (RegisterHotKey takes it; no app sees the keys), so the
test checks app_info first.
"""
import ctypes
import json
import sys
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

ULONG_PTR = ctypes.c_size_t


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class _U(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


def hotkey():
    VK_CONTROL, VK_SHIFT, VK_SPACE, KEYUP = 0x11, 0x10, 0x20, 0x0002

    def key(vk, up):
        i = INPUT(type=1)
        i.u.ki = KEYBDINPUT(vk, 0, KEYUP if up else 0, 0, 0)
        return i

    seq = [key(VK_CONTROL, False), key(VK_SHIFT, False), key(VK_SPACE, False), key(VK_SPACE, True), key(VK_SHIFT, True), key(VK_CONTROL, True)]
    arr = (INPUT * len(seq))(*seq)
    sent = user32.SendInput(len(seq), arr, ctypes.sizeof(INPUT))
    print(json.dumps({"sent": sent}))


def clipboard():
    CF_UNICODETEXT = 13
    user32.GetClipboardData.restype = ctypes.c_void_p
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    for _ in range(20):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        print(json.dumps({"error": "OpenClipboard failed"}))
        return
    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            print(json.dumps({"text": None}))
            return
        ptr = kernel32.GlobalLock(handle)
        try:
            print(json.dumps({"text": ctypes.wstring_at(ptr)}))
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _text(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _class(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def _find_dialog(pid, title):
    found = []

    def cb(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd) and _class(hwnd) == "#32770" and _text(hwnd) == title:
            found.append(hwnd)
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found[0] if found else None


def fill_dialog(pid, title, path):
    WM_SETTEXT, WM_COMMAND, IDOK = 0x000C, 0x0111, 1
    user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, ctypes.c_void_p]
    user32.SendMessageW.restype = ctypes.c_ssize_t
    user32.FindWindowExW.restype = wintypes.HWND
    user32.GetDlgItem.restype = wintypes.HWND
    deadline = time.time() + 15
    dlg = None
    while time.time() < deadline and not dlg:
        dlg = _find_dialog(pid, title)
        if not dlg:
            time.sleep(0.2)
    if not dlg:
        print(json.dumps({"ok": False, "error": f"no dialog titled {title!r}"}))
        return
    time.sleep(0.5)
    # The file name box of the open dialog: ComboBoxEx32 (id 1148) > ComboBox > Edit.
    combo = user32.GetDlgItem(dlg, 1148)
    edit = None
    if combo:
        inner = user32.FindWindowExW(combo, None, "ComboBox", None)
        edit = user32.FindWindowExW(inner, None, "Edit", None) if inner else None
    if not edit:
        print(json.dumps({"ok": False, "error": "no file name box"}))
        return
    buf = ctypes.create_unicode_buffer(path)
    user32.SendMessageW(edit, WM_SETTEXT, 0, ctypes.cast(buf, ctypes.c_void_p))
    time.sleep(0.2)
    user32.SendMessageW(dlg, WM_COMMAND, IDOK, None)
    end = time.time() + 10
    while time.time() < end and user32.IsWindow(dlg) and user32.IsWindowVisible(dlg):
        time.sleep(0.1)
    print(json.dumps({"ok": not (user32.IsWindow(dlg) and user32.IsWindowVisible(dlg))}))


def contact_sheet(out, images):
    from PIL import Image, ImageDraw

    cols, w = 4, 550
    thumbs = []
    for p in images:
        im = Image.open(p).convert("RGB")
        h = round(im.height * w / im.width)
        thumbs.append((p, im.resize((w, h))))
    # Each row is as tall as its tallest tile (Quick Access is taller).
    rows = [thumbs[i : i + cols] for i in range(0, len(thumbs), cols)]
    heights = [max(t.height for _, t in r) + 24 for r in rows]
    sheet = Image.new("RGB", (cols * (w + 8) + 8, sum(h + 8 for h in heights) + 8), (40, 40, 40))
    draw = ImageDraw.Draw(sheet)
    for n, (p, t) in enumerate(thumbs):
        r = n // cols
        x, y = 8 + (n % cols) * (w + 8), 8 + sum(h + 8 for h in heights[:r])
        sheet.paste(t, (x, y + 22))
        draw.text((x + 2, y + 4), p.replace("\\", "/").split("/")[-1], fill=(230, 230, 230))
    sheet.save(out)
    print(json.dumps({"ok": True, "out": out, "count": len(thumbs)}))


class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD), ("szDevice", wintypes.WCHAR * 32)]


MONITORENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)


def _per_monitor_aware():
    # Physical pixels everywhere (per-monitor DPI aware v2).
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))


def monitors():
    _per_monitor_aware()
    shcore = ctypes.WinDLL("shcore")
    out = []

    def cb(h, _dc, _r, _l):
        mi = MONITORINFOEXW()
        mi.cbSize = ctypes.sizeof(MONITORINFOEXW)
        user32.GetMonitorInfoW(h, ctypes.byref(mi))
        dx, dy = wintypes.UINT(), wintypes.UINT()
        shcore.GetDpiForMonitor(h, 0, ctypes.byref(dx), ctypes.byref(dy))
        w = mi.rcWork
        out.append({"device": mi.szDevice, "work": [w.left, w.top, w.right, w.bottom], "scale": dx.value / 96, "primary": bool(mi.dwFlags & 1)})
        return True

    user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(cb), 0)
    print(json.dumps(out))


def focus_at(x, y, seconds):
    """Open a small window with its top-left at physical (x, y), bring it to
    the front, press the Quick Access hotkey, and keep it open `seconds`.
    Quick Access then opens on that window's monitor."""
    _per_monitor_aware()
    import tkinter as tk

    root = tk.Tk()
    root.title("Coffer DPI probe")
    root.geometry(f"420x220+{x}+{y}")
    tk.Label(root, text="Coffer test window\nIt closes by itself.", font=("Segoe UI", 12)).pack(expand=True)
    root.update()
    hwnd = user32.GetAncestor(root.winfo_id(), 2)  # GA_ROOT
    # An Alt tap lets this process take the foreground (SetForegroundWindow rules).
    VK_MENU, KEYUP = 0x12, 0x0002
    tap = (INPUT * 2)(INPUT(type=1), INPUT(type=1))
    tap[0].u.ki = KEYBDINPUT(VK_MENU, 0, 0, 0, 0)
    tap[1].u.ki = KEYBDINPUT(VK_MENU, 0, KEYUP, 0, 0)
    user32.SendInput(2, tap, ctypes.sizeof(INPUT))
    user32.SetForegroundWindow(hwnd)
    root.focus_force()
    root.update()
    time.sleep(0.3)
    front = user32.GetForegroundWindow() == hwnd
    if front:
        hotkey()
    else:
        print(json.dumps({"sent": 0}))
    print(json.dumps({"front": front}), flush=True)
    root.after(int(seconds * 1000), root.destroy)
    root.mainloop()


def _visible_window(pid, title):
    found = []

    def cb(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd) and _text(hwnd) == title:
            found.append(hwnd)
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found[0] if found else None


def ctrl_wheel(pid, notches):
    """Hold Ctrl and turn the mouse wheel `notches` up over the middle of the
    visible Quick Access window of process `pid`, then put the cursor back.
    This is what a zoom gesture sends."""
    _per_monitor_aware()
    hwnd = _visible_window(pid, "Coffer Quick Access")
    if not hwnd:
        print(json.dumps({"ok": False, "error": "no visible Quick Access"}))
        return
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    x, y = (r.left + r.right) // 2, (r.top + r.bottom) // 2
    VK_CONTROL, KEYUP, MOUSEEVENTF_WHEEL, WHEEL_DELTA = 0x11, 0x0002, 0x0800, 120
    old = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(old))
    user32.SetCursorPos(x, y)
    time.sleep(0.15)
    ctrl = INPUT(type=1)
    ctrl.u.ki = KEYBDINPUT(VK_CONTROL, 0, 0, 0, 0)
    user32.SendInput(1, ctypes.byref(ctrl), ctypes.sizeof(INPUT))
    for _ in range(notches):
        w = INPUT(type=0)
        w.u.mi = MOUSEINPUT(0, 0, ctypes.c_ulong(WHEEL_DELTA).value, MOUSEEVENTF_WHEEL, 0, 0)
        user32.SendInput(1, ctypes.byref(w), ctypes.sizeof(INPUT))
        time.sleep(0.08)
    ctrl.u.ki = KEYBDINPUT(VK_CONTROL, 0, KEYUP, 0, 0)
    user32.SendInput(1, ctypes.byref(ctrl), ctypes.sizeof(INPUT))
    user32.SetCursorPos(old.x, old.y)
    print(json.dumps({"ok": True}))


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "monitors":
        monitors()
    elif cmd == "ctrl-wheel":
        ctrl_wheel(int(sys.argv[2]), int(sys.argv[3]))
    elif cmd == "focus-at":
        focus_at(int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]))
    elif cmd == "hotkey":
        hotkey()
    elif cmd == "clipboard":
        clipboard()
    elif cmd == "fill-dialog":
        fill_dialog(int(sys.argv[2]), sys.argv[3], sys.argv[4])
    elif cmd == "contact-sheet":
        contact_sheet(sys.argv[2], sys.argv[3:])
    else:
        sys.exit(f"unknown command {cmd}")
