// pi-purge prompt editor -- a single-file WinForms app.
//
// Edits the files the pi-purge extension actually reads, in place:
//   %USERPROFILE%\.pi\agent\pi-purge\
//     config.json         enabled / position / presets / auto-continue
//     prompt-inject.md    always injected
//     presets\*.md        injected on a model match
//
// The system prompt itself is Pi's own -- this only supplies the text injected
// into it, which is exactly what pi-purge does. Nothing here patches a host.
//
// Compiled by tools/build-editor.ps1 into dist/pi-purge-editor.exe.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace PiPurgeEditor
{
    internal static class Program
    {
        internal const string AppTitle = "pi-purge prompt editor";
        internal const string Version = "0.1.0";

        [STAThread]
        private static void Main(string[] args)
        {
            var silent = false;
            var dump = false;
            foreach (var a in args ?? new string[0])
            {
                if (a.Equals("--silent", StringComparison.OrdinalIgnoreCase)) silent = true;
                if (a.Equals("--dump", StringComparison.OrdinalIgnoreCase)) dump = true;
            }

            if (silent || dump)
            {
                // Console subsystem is what makes stdout redirectable at all; a
                // winexe's output is unrecoverable once redirected. GUI mode detaches
                // the console so a double-click shows no black window.
                Environment.ExitCode = Headless.Run(dump);
                return;
            }

            Headless.DetachForGui();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new EditorForm());
        }
    }

    /// <summary>The pi-purge data directory and its files.</summary>
    internal sealed class Store
    {
        internal readonly string Dir;
        internal string ConfigPath { get { return Path.Combine(Dir, "config.json"); } }
        internal string InjectPath { get { return Path.Combine(Dir, "prompt-inject.md"); } }
        internal string PresetsDir { get { return Path.Combine(Dir, "presets"); } }

        internal Store()
        {
            var agentDir = Environment.GetEnvironmentVariable("PI_CODING_AGENT_DIR");
            if (string.IsNullOrEmpty(agentDir))
                agentDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".pi", "agent");
            Dir = Path.Combine(agentDir, "pi-purge");
        }

        internal bool Exists { get { return Directory.Exists(Dir); } }

        internal string[] PresetFiles()
        {
            if (!Directory.Exists(PresetsDir)) return new string[0];
            var files = Directory.GetFiles(PresetsDir, "*.md");
            Array.Sort(files, StringComparer.OrdinalIgnoreCase);
            return files;
        }

        /// <summary>
        /// Writes beside the target and swaps, so an editor crash mid-save cannot
        /// truncate the prompt. UTF-8 without BOM, matching what pi-purge reads.
        /// </summary>
        internal static void AtomicWrite(string path, string text)
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
        }

        internal static string Read(string path)
        {
            if (!File.Exists(path)) return "";
            return File.ReadAllText(path, Encoding.UTF8);
        }
    }

    /// <summary>
    /// A deliberately small config model. pi-purge's config.json is read and
    /// rewritten whole, so unknown keys are preserved by keeping the original text
    /// and only replacing the fields this editor owns.
    /// </summary>
    internal sealed class ConfigModel
    {
        internal bool Enabled = true;
        internal string Position = "append";
        internal bool AutoContinue = true;
        internal int ContinueMax = 3;
        internal string ContinueText = "继续";
        internal string ActivePreset;              // null = auto by model match
        internal List<string[]> ModelPresets = new List<string[]>(); // {match, preset}

        internal static ConfigModel Load(string path)
        {
            var m = new ConfigModel();
            if (!File.Exists(path)) return m;
            var text = File.ReadAllText(path, Encoding.UTF8);

            var enabled = JsonScan.Bool(text, "enabled");
            if (enabled.HasValue) m.Enabled = enabled.Value;

            var pos = JsonScan.String(text, "position");
            if (pos == "prepend" || pos == "append") m.Position = pos;

            var auto = JsonScan.Bool(text, "autoContinue");
            if (auto.HasValue) m.AutoContinue = auto.Value;

            var max = JsonScan.Int(text, "continueMax");
            if (max.HasValue && max.Value > 0) m.ContinueMax = max.Value;

            var ct = JsonScan.String(text, "continueText");
            if (!string.IsNullOrEmpty(ct)) m.ContinueText = ct;

            m.ActivePreset = JsonScan.String(text, "activePreset"); // "" or null when absent
            foreach (var pair in JsonScan.ObjectArrayPairs(text, "modelPresets", "match", "preset"))
                m.ModelPresets.Add(pair);
            return m;
        }

        /// <summary>
        /// Serialises in the same shape pi-purge writes (2-space indent, trailing
        /// newline) so a round-trip through this editor produces no diff noise.
        /// </summary>
        internal string ToJson()
        {
            var sb = new StringBuilder();
            sb.Append("{\n");
            sb.Append("  \"enabled\": ").Append(Enabled ? "true" : "false").Append(",\n");
            sb.Append("  \"position\": ").Append(JsonScan.Quote(Position)).Append(",\n");
            sb.Append("  \"activePreset\": ").Append(
                string.IsNullOrEmpty(ActivePreset) ? "null" : JsonScan.Quote(ActivePreset)).Append(",\n");

            sb.Append("  \"modelPresets\": [");
            if (ModelPresets.Count == 0) sb.Append("],\n");
            else
            {
                sb.Append("\n");
                for (var i = 0; i < ModelPresets.Count; i++)
                {
                    sb.Append("    { \"match\": ").Append(JsonScan.Quote(ModelPresets[i][0]))
                      .Append(", \"preset\": ").Append(JsonScan.Quote(ModelPresets[i][1])).Append(" }");
                    sb.Append(i == ModelPresets.Count - 1 ? "\n" : ",\n");
                }
                sb.Append("  ],\n");
            }

            sb.Append("  \"autoContinue\": ").Append(AutoContinue ? "true" : "false").Append(",\n");
            sb.Append("  \"continueMax\": ").Append(ContinueMax).Append(",\n");
            sb.Append("  \"continueText\": ").Append(JsonScan.Quote(ContinueText)).Append("\n");
            sb.Append("}\n");
            return sb.ToString();
        }
    }

    /// <summary>
    /// Just enough JSON reading for this one file. A full parser would be the right
    /// call for arbitrary JSON; here the shape is fixed and known, and pulling in a
    /// dependency for it would defeat the "compiles with what Windows has" goal.
    /// </summary>
    internal static class JsonScan
    {
        internal static bool? Bool(string text, string key)
        {
            var v = Raw(text, key);
            if (v == null) return null;
            if (v.StartsWith("true", StringComparison.OrdinalIgnoreCase)) return true;
            if (v.StartsWith("false", StringComparison.OrdinalIgnoreCase)) return false;
            return null;
        }

        internal static int? Int(string text, string key)
        {
            var v = Raw(text, key);
            if (v == null) return null;
            var digits = new StringBuilder();
            foreach (var c in v) { if (char.IsDigit(c) || c == '-') digits.Append(c); else break; }
            int parsed;
            return int.TryParse(digits.ToString(), out parsed) ? (int?)parsed : null;
        }

        internal static string String(string text, string key)
        {
            var v = Raw(text, key);
            if (v == null) return null;
            v = v.TrimStart();
            if (v.Length > 0 && v[0] == '"')
            {
                int ignored;
                return ParseQuoted(v, 0, out ignored);
            }
            if (v.StartsWith("null", StringComparison.OrdinalIgnoreCase)) return null;
            return null;
        }

        private static string Raw(string text, string key)
        {
            var needle = "\"" + key + "\"";
            var i = text.IndexOf(needle, StringComparison.Ordinal);
            if (i < 0) return null;
            var colon = text.IndexOf(':', i + needle.Length);
            if (colon < 0) return null;
            return text.Substring(colon + 1).TrimStart();
        }

        /// <summary>Extracts the {match, preset} pairs of the modelPresets array.</summary>
        internal static List<string[]> ObjectArrayPairs(string text, string arrayKey, string keyA, string keyB)
        {
            var result = new List<string[]>();
            var needle = "\"" + arrayKey + "\"";
            var i = text.IndexOf(needle, StringComparison.Ordinal);
            if (i < 0) return result;
            var open = text.IndexOf('[', i);
            if (open < 0) return result;

            var depth = 0;
            var objStart = -1;
            for (var p = open; p < text.Length; p++)
            {
                var c = text[p];
                if (c == '"')
                {
                    p = SkipString(text, p);
                    continue;
                }
                if (c == '{') { if (depth++ == 0) objStart = p; }
                else if (c == '}')
                {
                    if (--depth == 0 && objStart >= 0)
                    {
                        var body = text.Substring(objStart, p - objStart + 1);
                        var a = String(body, keyA);
                        var b = String(body, keyB);
                        if (a != null && b != null) result.Add(new[] { a, b });
                        objStart = -1;
                    }
                }
                else if (c == ']' && depth == 0) break;
            }
            return result;
        }

        private static int SkipString(string text, int start)
        {
            for (var p = start + 1; p < text.Length; p++)
            {
                if (text[p] == '\\') { p++; continue; }
                if (text[p] == '"') return p;
            }
            return text.Length - 1;
        }

        private static string ParseQuoted(string text, int start, out int end)
        {
            var sb = new StringBuilder();
            var i = start + 1;
            end = i;
            while (i < text.Length)
            {
                var c = text[i];
                if (c == '\\' && i + 1 < text.Length)
                {
                    var n = text[++i];
                    switch (n)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 't': sb.Append('\t'); break;
                        case 'r': sb.Append('\r'); break;
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'u':
                            if (i + 4 < text.Length)
                            {
                                int code;
                                if (int.TryParse(text.Substring(i + 1, 4),
                                        System.Globalization.NumberStyles.HexNumber, null, out code))
                                {
                                    sb.Append((char)code);
                                    i += 4;
                                    break;
                                }
                            }
                            sb.Append(n);
                            break;
                        default: sb.Append(n); break;
                    }
                    i++;
                    continue;
                }
                if (c == '"') { end = i; return sb.ToString(); }
                sb.Append(c);
                i++;
            }
            end = text.Length;
            return sb.ToString();
        }

        internal static string Quote(string value)
        {
            if (value == null) return "null";
            var sb = new StringBuilder("\"");
            foreach (var c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }
    }

    /// <summary>Headless mode so CI can verify the binary without a desktop session.</summary>
    internal static class Headless
    {
        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        private static extern bool FreeConsole();

        private const int AttachParentProcess = -1;

        /// <summary>
        /// The exe is built for the console subsystem so stdout can be redirected
        /// (a winexe's stdout is unrecoverable once redirected -- verified, not
        /// assumed). For a normal double-click launch the console is detached so no
        /// black window sits behind the editor.
        /// </summary>
        internal static void DetachForGui()
        {
            FreeConsole();
        }

        internal static int Run(bool dump)
        {
            var store = new Store();
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine(Program.AppTitle + " " + Program.Version);
            Console.WriteLine("data dir: " + store.Dir);
            Console.WriteLine("exists  : " + store.Exists);

            if (!store.Exists)
            {
                Console.WriteLine("pi-purge is not installed (no data directory).");
                Console.WriteLine("Install it under ~/.pi/agent/pi-purge/ first.");
                return 1;
            }

            var cfg = ConfigModel.Load(store.ConfigPath);
            Console.WriteLine("enabled : " + cfg.Enabled);
            Console.WriteLine("position: " + cfg.Position);
            Console.WriteLine("autoContinue: " + cfg.AutoContinue + " (max " + cfg.ContinueMax + ")");
            Console.WriteLine("continueText: " + cfg.ContinueText);
            Console.WriteLine("activePreset: " + (string.IsNullOrEmpty(cfg.ActivePreset) ? "(auto by model)" : cfg.ActivePreset));
            Console.WriteLine("modelPresets: " + cfg.ModelPresets.Count + " rule(s)");

            var inject = Store.Read(store.InjectPath);
            Console.WriteLine("prompt-inject.md: " + inject.Length + " chars");
            var presets = store.PresetFiles();
            Console.WriteLine("presets: " + presets.Length);
            foreach (var f in presets)
                Console.WriteLine("  " + Path.GetFileName(f) + "  " + Store.Read(f).Length + " chars");

            if (dump)
            {
                Console.WriteLine("--- config.json (round-trip) ---");
                Console.Write(cfg.ToJson());
            }
            return 0;
        }
    }
}
