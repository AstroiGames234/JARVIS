param(
    [ValidateSet('Hide', 'Show')]
    [string]$Action = 'Hide'
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace JarvisBackground {
    public static class Native {
        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hwnd, int command);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

        public static IntPtr FindJarvisWindow() {
            IntPtr found = IntPtr.Zero;
            EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr lParam) {
                StringBuilder title = new StringBuilder(512);
                GetWindowText(hwnd, title, title.Capacity);
                if (title.ToString().IndexOf("J.A.R.V.I.S.", StringComparison.OrdinalIgnoreCase) >= 0) {
                    found = hwnd;
                    return false;
                }
                return true;
            };
            EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return found;
        }
    }
}
'@

$window = [JarvisBackground.Native]::FindJarvisWindow()
if ($window -eq [IntPtr]::Zero) { exit 1 }

if ($Action -eq 'Hide') {
    [void][JarvisBackground.Native]::ShowWindow($window, 0)
} else {
    [void][JarvisBackground.Native]::ShowWindow($window, 9)
    [void][JarvisBackground.Native]::SetForegroundWindow($window)
}
