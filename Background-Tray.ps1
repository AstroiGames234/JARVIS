$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Web.Extensions

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($false, 'Local\JARVIS_Background_Tray', [ref]$createdNew)
if (-not $createdNew) { exit 0 }

try {
    $references = @(
        [System.Net.WebRequest].Assembly.Location,
        [System.Linq.Enumerable].Assembly.Location,
        [System.Windows.Forms.NotifyIcon].Assembly.Location,
        [System.Drawing.SystemIcons].Assembly.Location,
        [System.Speech.Recognition.SpeechRecognitionEngine].Assembly.Location,
        [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
    ) | Select-Object -Unique
    Add-Type -ReferencedAssemblies $references -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Speech.Recognition;
using System.Web.Script.Serialization;

namespace JarvisBackground {
    public static class TrayNative {
        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

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

    public static class TrayApp {
        private enum ListenMode { WakeWord, StartingCommand, Command, Processing, AppOwnsMicrophone }
        private static readonly object StateLock = new object();
        private static ListenMode mode = ListenMode.AppOwnsMicrophone;
        private static string pendingCommand = "";
        private static SpeechRecognitionEngine recognizer;
        private static NotifyIcon icon;
        private static ContextMenuStrip menu;
        private static ToolStripMenuItem statusItem;
        private static System.Windows.Forms.Timer ownershipTimer;
        private static volatile bool foregroundAppOwnsMicrophone = true;
        private static volatile bool trayAudioReleased = true;
        private static string lastLocalSpeechError = "";
        private static Grammar wakeGrammar;
        private static Grammar dictationGrammar;
        private static CultureInfo speechCulture;

        public static void Run() {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            BuildTray();
            Application.ApplicationExit += delegate { DisposeSpeech(); };
            try {
                StartSpeech();
                statusItem.Text = "Waiting for microphone owner";
                statusItem.Checked = false;
                icon.Text = "J.A.R.V.I.S. — waiting for microphone owner";
                ReportStatus(false, "Waiting for the app window to claim the microphone.", true, true);
                ownershipTimer = new System.Windows.Forms.Timer { Interval = 1000 };
                ownershipTimer.Tick += delegate { CheckForegroundOwnership(); };
                ownershipTimer.Start();
            } catch (Exception error) {
                icon.Text = "J.A.R.V.I.S. — microphone unavailable";
                statusItem.Text = "Voice setup needed";
                statusItem.Checked = false;
                ReportStatus(false, Short(error.Message), false, false);
                ShowNotice("Background voice could not start. " + Short(error.Message));
            }
            Application.Run();
        }

        private static void BuildTray() {
            menu = new ContextMenuStrip();
            statusItem = new ToolStripMenuItem("Listening for Jarvis") { Enabled = false, Checked = true, CheckOnClick = false };
            ToolStripMenuItem show = new ToolStripMenuItem("Show J.A.R.V.I.S.");
            ToolStripMenuItem hide = new ToolStripMenuItem("Hide to background");
            ToolStripMenuItem speechSettings = new ToolStripMenuItem("Open Windows speech settings");
            ToolStripMenuItem microphoneSettings = new ToolStripMenuItem("Open microphone privacy settings");
            ToolStripMenuItem exit = new ToolStripMenuItem("Exit J.A.R.V.I.S.");
            show.Click += delegate { ShowJarvisWindow(); };
            hide.Click += delegate { HideJarvisWindow(); };
            speechSettings.Click += delegate { OpenWindowsSettings("ms-settings:speech"); };
            microphoneSettings.Click += delegate { OpenWindowsSettings("ms-settings:privacy-microphone"); };
            exit.Click += delegate { ExitJarvis(); };
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(show);
            menu.Items.Add(hide);
            menu.Items.Add(speechSettings);
            menu.Items.Add(microphoneSettings);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exit);
            icon = new NotifyIcon {
                Icon = System.Drawing.SystemIcons.Application,
                Text = "J.A.R.V.I.S. — listening for Jarvis",
                ContextMenuStrip = menu,
                Visible = true
            };
            icon.DoubleClick += delegate { ShowJarvisWindow(); };
        }

        private static void StartSpeech() {
            RecognizerInfo selected = SpeechRecognitionEngine.InstalledRecognizers()
                .Where(r => r.Culture.TwoLetterISOLanguageName.Equals("en", StringComparison.OrdinalIgnoreCase))
                .OrderBy(r => r.Culture.Name.Equals("en-GB", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .FirstOrDefault();
            if (selected == null) throw new InvalidOperationException("Install an English speech recognition language in Windows Settings.");

            speechCulture = selected.Culture;
            recognizer = new SpeechRecognitionEngine(selected);
            recognizer.InitialSilenceTimeout = TimeSpan.Zero;
            recognizer.BabbleTimeout = TimeSpan.FromSeconds(5);
            wakeGrammar = BuildWakeGrammar(speechCulture);
            dictationGrammar = new DictationGrammar();
            recognizer.LoadGrammar(wakeGrammar);
            recognizer.SpeechRecognized += OnSpeechRecognized;
            recognizer.RecognizeCompleted += OnRecognizeCompleted;

        }

        private static string ListeningStatus() {
            return "Listening for Jarvis in the Windows tray. Local Kokoro speech is enabled for spoken replies.";
        }

        private static bool TrySpeakLocal(string text) {
            try {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                byte[] data = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object> { { "text", text ?? "" } }));
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/tts");
                request.Method = "POST";
                request.ContentType = "application/json; charset=utf-8";
                request.Timeout = 35000;
                request.ReadWriteTimeout = 35000;
                request.ContentLength = data.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (MemoryStream audio = new MemoryStream()) {
                    response.GetResponseStream().CopyTo(audio);
                    byte[] wav = audio.ToArray();
                    if (wav.Length < 44 || Encoding.ASCII.GetString(wav, 0, 4) != "RIFF" || Encoding.ASCII.GetString(wav, 8, 4) != "WAVE") return false;
                    audio.Position = 0;
                    using (System.Media.SoundPlayer player = new System.Media.SoundPlayer(audio)) {
                        player.Load();
                        player.PlaySync();
                    }
                    return true;
                }
            } catch (WebException error) {
                lastLocalSpeechError = Short(error.Message);
                try {
                    using (WebResponse response = error.Response)
                    using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                        Dictionary<string, object> body = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                        object detail;
                        if (body != null && body.TryGetValue("error", out detail) && detail is string) lastLocalSpeechError = Short((string)detail);
                    }
                } catch { }
                return false;
            } catch (Exception error) {
                lastLocalSpeechError = Short(error.Message);
                return false;
            }
        }

        private static void ShowLocalSpeechUnavailable() {
            string detail = String.IsNullOrWhiteSpace(lastLocalSpeechError) ? "" : " " + lastLocalSpeechError;
            ShowNotice("Local J.A.R.V.I.S. speech is unavailable." + detail + " Run Setup-Local-AI.cmd from the app folder.");
        }

        private static Grammar BuildWakeGrammar(CultureInfo culture) {
            Choices phrases = new Choices(new string[] { "Jarvis", "Hey Jarvis" });
            GrammarBuilder builder = new GrammarBuilder();
            builder.Culture = culture;
            builder.Append(phrases);
            GrammarBuilder optionalCommand = new GrammarBuilder();
            optionalCommand.Culture = culture;
            optionalCommand.AppendDictation();
            builder.Append(optionalCommand, 0, 1);
            return new Grammar(builder);
        }

        private static void OnSpeechRecognized(object sender, SpeechRecognizedEventArgs args) {
            if (args.Result == null || args.Result.Confidence < 0.48f) return;
            if (foregroundAppOwnsMicrophone) return;
            ListenMode current;
            lock (StateLock) current = mode;
            if (current == ListenMode.WakeWord) {
                string recognized = args.Result.Text == null ? "" : args.Result.Text.Trim();
                Match wake = Regex.Match(recognized, @"^(?:hey\s+)?jarvis\b[\s,.:;!?-]*(.*)$", RegexOptions.IgnoreCase);
                if (!wake.Success) return;
                string command = wake.Groups[1].Value.Trim();
                lock (StateLock) {
                    if (mode != ListenMode.WakeWord) return;
                    pendingCommand = command;
                    mode = String.IsNullOrWhiteSpace(command) ? ListenMode.StartingCommand : ListenMode.Processing;
                }
                try { recognizer.RecognizeAsyncCancel(); } catch { }
            } else if (current == ListenMode.Command) {
                string text = args.Result.Text == null ? "" : args.Result.Text.Trim();
                lock (StateLock) {
                    if (mode != ListenMode.Command) return;
                    pendingCommand = text;
                    mode = ListenMode.Processing;
                }
            }
        }

        private static void OnRecognizeCompleted(object sender, RecognizeCompletedEventArgs args) {
            ListenMode current;
            string command = "";
            lock (StateLock) {
                current = mode;
                if (current == ListenMode.Processing) command = pendingCommand;
            }

            if (foregroundAppOwnsMicrophone && current != ListenMode.Processing) {
                lock (StateLock) mode = ListenMode.AppOwnsMicrophone;
                if (DetachTrayAudio()) ReportStatus(false, "The visible app owns the microphone.", true, true);
                return;
            }

            if (current == ListenMode.StartingCommand) {
                try {
                    if (!TrySpeakLocal("Yes, sir?")) ShowLocalSpeechUnavailable();
                    recognizer.UnloadAllGrammars();
                    dictationGrammar = new DictationGrammar();
                    recognizer.LoadGrammar(dictationGrammar);
                    recognizer.InitialSilenceTimeout = TimeSpan.FromSeconds(8);
                    recognizer.EndSilenceTimeout = TimeSpan.FromSeconds(1.2);
                    recognizer.EndSilenceTimeoutAmbiguous = TimeSpan.FromSeconds(1.8);
                    lock (StateLock) mode = ListenMode.Command;
                    recognizer.RecognizeAsync(RecognizeMode.Single);
                } catch (Exception error) {
                    ShowNotice("I could not start command listening. " + Short(error.Message));
                    RestoreWakeListening("I’m listening again, sir.");
                }
            } else if (current == ListenMode.Processing) {
                ThreadPool.QueueUserWorkItem(delegate { ProcessCommand(command); });
            } else if (current == ListenMode.Command) {
                ProcessCommand(" ");
            } else if (current == ListenMode.WakeWord && args.Error != null) {
                ShowNotice("Microphone listening stopped. " + Short(args.Error.Message));
            }
        }

        private static void ProcessCommand(string command) {
            string response;
            if (String.IsNullOrWhiteSpace(command)) {
                response = "I didn’t catch that, sir. Say Jarvis when you’re ready.";
            } else {
                try {
                    response = SendCommand(command);
                } catch (Exception error) {
                    response = "I’m sorry, sir. " + Short(error.Message);
                }
            }
            bool appSpoke = TrySpeakInApp(response);
            if (!appSpoke && !TrySpeakLocal(response)) ShowLocalSpeechUnavailable();
            RestoreWakeListening("I’m listening again, sir.");
        }

        private static string SendCommand(string command) {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            byte[] data = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object> { { "command", command } }));
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/assistant-command");
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.Timeout = 55000;
            request.ReadWriteTimeout = 55000;
            request.ContentLength = data.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
            try {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    Dictionary<string, object> result = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object text;
                    if (result != null && result.TryGetValue("response", out text) && text is string && !String.IsNullOrWhiteSpace((string)text)) return (string)text;
                    if (result != null && result.TryGetValue("error", out text) && text is string) return (string)text;
                }
            } catch (WebException error) {
                HttpWebResponse response = error.Response as HttpWebResponse;
                if (response == null) throw new InvalidOperationException("The local assistant server is not running.", error);
                using (response)
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    Dictionary<string, object> result = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object detail;
                    if (result != null && result.TryGetValue("error", out detail) && detail is string && !String.IsNullOrWhiteSpace((string)detail)) return (string)detail;
                }
                throw new InvalidOperationException("The local assistant could not complete that request.", error);
            }
            return "I could not complete that request, sir.";
        }

        private static bool TrySpeakInApp(string text) {
            try {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                byte[] data = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object> { { "text", text } }));
                HttpWebRequest create = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/background/speech");
                create.Method = "POST";
                create.ContentType = "application/json; charset=utf-8";
                create.Timeout = 2000;
                create.ContentLength = data.Length;
                using (Stream stream = create.GetRequestStream()) stream.Write(data, 0, data.Length);
                string id;
                using (HttpWebResponse response = (HttpWebResponse)create.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    Dictionary<string, object> created = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object value;
                    if (created == null || !created.TryGetValue("id", out value) || !(value is string)) return false;
                    id = (string)value;
                }
                for (int attempt = 0; attempt < 240; attempt++) {
                    Thread.Sleep(250);
                    HttpWebRequest check = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/background/speech/result?id=" + Uri.EscapeDataString(id));
                    check.Timeout = 2000;
                    using (HttpWebResponse response = (HttpWebResponse)check.GetResponse())
                    using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                        Dictionary<string, object> state = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                        object complete, handled, claimed;
                        if (state != null && state.TryGetValue("complete", out complete) && complete is bool && (bool)complete) {
                            return state.TryGetValue("handled", out handled) && handled is bool && (bool)handled;
                        }
                        if (attempt >= 20 && state != null && state.TryGetValue("claimed", out claimed) && claimed is bool && !(bool)claimed) return false;
                    }
                }
            } catch { }
            return false;
        }

        private static void ReportStatus(bool ready, string message, bool foregroundPaused, bool available) {
            try {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                byte[] data = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object> {
                    { "ready", ready }, { "message", message }, { "foregroundPaused", foregroundPaused }, { "available", available }
                }));
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/background/status");
                request.Method = "POST";
                request.ContentType = "application/json; charset=utf-8";
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                request.ContentLength = data.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
                using (WebResponse response = request.GetResponse()) { }
            } catch { }
        }

        private static void CheckForegroundOwnership() {
            bool active = false;
            try {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/foreground/status");
                request.Timeout = 800;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    Dictionary<string, object> result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object value;
                    active = result != null && result.TryGetValue("active", out value) && value is bool && (bool)value;
                }
            } catch { return; }

            if (foregroundAppOwnsMicrophone == active) {
                if (active) {
                    if (!trayAudioReleased) {
                        try { recognizer.RecognizeAsyncCancel(); } catch { }
                        if (!DetachTrayAudio()) {
                            ReportStatus(false, "Releasing the tray microphone for the visible app.", false, true);
                            return;
                        }
                    }
                    if (statusItem != null) { statusItem.Text = "App has microphone priority"; statusItem.Checked = false; }
                    if (icon != null) icon.Text = "J.A.R.V.I.S. — app has microphone priority";
                    ReportStatus(false, "The visible app owns the microphone.", true, true);
                }
                else if (mode == ListenMode.WakeWord) ReportStatus(true, ListeningStatus(), false, true);
                return;
            }
            foregroundAppOwnsMicrophone = active;
            if (active) {
                ListenMode current;
                lock (StateLock) current = mode;
                try { recognizer.RecognizeAsyncCancel(); } catch { }
                bool released = DetachTrayAudio();
                if (current != ListenMode.Processing) {
                    lock (StateLock) {
                        mode = ListenMode.AppOwnsMicrophone;
                        pendingCommand = "";
                    }
                }
                if (statusItem != null) { statusItem.Text = "App has microphone priority"; statusItem.Checked = false; }
                if (icon != null) icon.Text = "J.A.R.V.I.S. — app has microphone priority";
                ReportStatus(false, released ? "The visible app owns the microphone." : "Releasing the tray microphone for the visible app.", released, true);
            } else {
                ListenMode current;
                lock (StateLock) current = mode;
                if (current == ListenMode.AppOwnsMicrophone) RestoreWakeListening("The app is hidden. Tray listening resumed.");
            }
        }

        private static void RestoreWakeListening(string notice) {
            try {
                if (foregroundAppOwnsMicrophone) {
                    try { recognizer.RecognizeAsyncCancel(); } catch { }
                    bool released = DetachTrayAudio();
                    lock (StateLock) {
                        mode = ListenMode.AppOwnsMicrophone;
                        pendingCommand = "";
                    }
                    if (statusItem != null) { statusItem.Text = "App has microphone priority"; statusItem.Checked = false; }
                    if (icon != null) icon.Text = "J.A.R.V.I.S. — app has microphone priority";
                    if (released) ReportStatus(false, "The visible app owns the microphone.", true, true);
                    return;
                }
                recognizer.UnloadAllGrammars();
                recognizer.LoadGrammar(wakeGrammar);
                recognizer.SetInputToDefaultAudioDevice();
                trayAudioReleased = false;
                recognizer.InitialSilenceTimeout = TimeSpan.Zero;
                recognizer.EndSilenceTimeout = TimeSpan.FromMilliseconds(250);
                recognizer.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(350);
                lock (StateLock) {
                    mode = ListenMode.WakeWord;
                    pendingCommand = "";
                }
                recognizer.RecognizeAsync(RecognizeMode.Multiple);
                if (statusItem != null) { statusItem.Text = "Listening for Jarvis in background"; statusItem.Checked = true; }
                if (icon != null) icon.Text = "J.A.R.V.I.S. — listening in background";
                ReportStatus(true, ListeningStatus(), false, true);
            } catch (Exception error) {
                ReportStatus(false, Short(error.Message), foregroundAppOwnsMicrophone, true);
                ShowNotice("Wake listening stopped. " + Short(error.Message));
            }
        }

        private static bool DetachTrayAudio() {
            if (recognizer == null) { trayAudioReleased = true; return true; }
            try {
                recognizer.SetInputToNull();
                trayAudioReleased = true;
                return true;
            } catch { return trayAudioReleased; }
        }

        private static void ShowJarvisWindow() {
            IntPtr window = TrayNative.FindJarvisWindow();
            if (window == IntPtr.Zero) {
                string edge = new[] {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe")
                }.FirstOrDefault(File.Exists);
                try {
                    if (!String.IsNullOrEmpty(edge)) Process.Start(edge, "--app=http://127.0.0.1:48123 --new-window");
                    else Process.Start("http://127.0.0.1:48123");
                } catch { }
                for (int i = 0; i < 40 && window == IntPtr.Zero; i++) {
                    Thread.Sleep(250);
                    window = TrayNative.FindJarvisWindow();
                }
            }
            if (window != IntPtr.Zero) {
                TrayNative.ShowWindow(window, 9);
                TrayNative.SetForegroundWindow(window);
            }
        }

        private static void HideJarvisWindow() {
            IntPtr window = TrayNative.FindJarvisWindow();
            if (window != IntPtr.Zero) TrayNative.ShowWindow(window, 0);
        }

        private static void OpenWindowsSettings(string address) {
            try { Process.Start(new ProcessStartInfo { FileName = address, UseShellExecute = true }); }
            catch (Exception error) { ShowNotice("Windows Settings could not open. " + Short(error.Message)); }
        }

        private static void ExitJarvis() {
            IntPtr window = TrayNative.FindJarvisWindow();
            if (window != IntPtr.Zero) TrayNative.PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
            try {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/shutdown");
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Timeout = 2500;
                request.ReadWriteTimeout = 2500;
                request.ContentLength = 2;
                using (Stream stream = request.GetRequestStream()) stream.Write(new byte[] { 123, 125 }, 0, 2);
                using (WebResponse response = request.GetResponse()) { }
            } catch { }
            try { DisposeSpeech(); } catch { }
            Application.ExitThread();
        }

        private static void ShowNotice(string message) {
            try {
                icon.BalloonTipTitle = "J.A.R.V.I.S. Background Voice";
                icon.BalloonTipText = Short(message);
                icon.BalloonTipIcon = ToolTipIcon.Info;
                icon.ShowBalloonTip(5000);
            } catch { }
        }

        private static string Short(string text) {
            if (String.IsNullOrWhiteSpace(text)) return "Please check the tray voice setup.";
            string clean = text.Replace('\r', ' ').Replace('\n', ' ').Trim();
            return clean.Length > 180 ? clean.Substring(0, 177) + "..." : clean;
        }

        private static void DisposeSpeech() {
            try { if (ownershipTimer != null) { ownershipTimer.Stop(); ownershipTimer.Dispose(); } } catch { }
            try { if (recognizer != null) { recognizer.RecognizeAsyncCancel(); recognizer.Dispose(); } } catch { }
            try { if (icon != null) { icon.Visible = false; icon.Dispose(); } } catch { }
            try { if (menu != null) menu.Dispose(); } catch { }
        }
    }
}
'@
    [JarvisBackground.TrayApp]::Run()
} finally {
    $mutex.Dispose()
}
