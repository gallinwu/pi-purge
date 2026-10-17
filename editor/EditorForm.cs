// The editor window: three tabs (main prompt / presets / settings), autosave on
// switch, and a status line that always says where the file lives. Saving writes
// exactly what pi-purge reads, so the next turn picks it up without a reload.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace PiPurgeEditor
{
    internal sealed class EditorForm : Form
    {
        private readonly Store _store = new Store();
        private ConfigModel _config;

        private readonly TabControl _tabs = new TabControl();
        private readonly TextBox _promptBox = new TextBox();
        private readonly TextBox _presetBox = new TextBox();
        private readonly ComboBox _presetPicker = new ComboBox();

        private readonly CheckBox _enabled = new CheckBox();
        private readonly ComboBox _position = new ComboBox();
        private readonly CheckBox _autoContinue = new CheckBox();
        private readonly NumericUpDown _continueMax = new NumericUpDown();
        private readonly TextBox _continueText = new TextBox();
        private readonly Label _presetInfo = new Label();

        private Label _status;
        private Label _counts;
        private string _currentPresetFile;
        private bool _dirtyPrompt;
        private bool _dirtyPreset;
        private bool _loading;

        internal EditorForm()
        {
            Text = Program.AppTitle + " " + Program.Version;
            ClientSize = new Size(880, 660);
            MinimumSize = new Size(700, 520);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9f);
            BackColor = Color.FromArgb(250, 250, 252);

            if (!_store.Exists)
            {
                ShowMissingInstall();
                return;
            }
            _config = ConfigModel.Load(_store.ConfigPath);
            BuildUi();
            LoadAll();
        }

        private void ShowMissingInstall()
        {
            var panel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24) };
            var msg = new Label
            {
                Dock = DockStyle.Top,
                Height = 120,
                Text = "pi-purge is not installed.\n\nExpected data directory:\n" + _store.Dir +
                       "\n\nInstall the pi-purge extension into ~/.pi/agent/pi-purge/ first, then reopen this editor.",
            };
            var open = new Button { Text = "Open ~/.pi/agent", Dock = DockStyle.Top, Height = 34 };
            open.Click += delegate { Reveal(Path.GetDirectoryName(_store.Dir)); };
            panel.Controls.Add(open);
            panel.Controls.Add(msg);
            Controls.Add(panel);
        }

        private void BuildUi()
        {
            var header = new Panel { Dock = DockStyle.Top, Height = 74, BackColor = Color.FromArgb(26, 28, 36) };
            header.Controls.Add(new Label
            {
                Text = "pi-purge",
                ForeColor = Color.White,
                Font = new Font("Segoe UI Semibold", 16f),
                AutoSize = true,
                Location = new Point(20, 12),
            });
            header.Controls.Add(new Label
            {
                Text = "Edit the text injected into Pi's own system prompt. Changes apply on the next turn.",
                ForeColor = Color.FromArgb(166, 172, 188),
                AutoSize = true,
                Location = new Point(22, 44),
            });
            Controls.Add(header);

            _tabs.Dock = DockStyle.Fill;
            _tabs.Padding = new Point(14, 6);
            Controls.Add(_tabs);

            BuildPromptTab();
            BuildPresetTab();
            BuildSettingsTab();

            var bottom = new Panel { Dock = DockStyle.Bottom, Height = 62, BackColor = Color.FromArgb(242, 243, 247) };
            Controls.Add(bottom);

            _status = new Label
            {
                Location = new Point(16, 8),
                Size = new Size(560, 20),
                Text = "Ready.",
                ForeColor = Color.FromArgb(60, 64, 76),
            };
            bottom.Controls.Add(_status);

            _counts = new Label
            {
                Location = new Point(16, 30),
                Size = new Size(560, 20),
                ForeColor = Color.FromArgb(120, 126, 140),
            };
            bottom.Controls.Add(_counts);

            var save = MakeButton("Save all", 600, Color.FromArgb(38, 104, 214), Color.White);
            save.Click += delegate { SaveAll(true); };
            bottom.Controls.Add(save);

            var folder = MakeButton("Open folder", 712, Color.FromArgb(232, 234, 240), Color.FromArgb(40, 44, 54));
            folder.Size = new Size(120, 34);
            folder.Click += delegate { Reveal(_store.Dir); };
            bottom.Controls.Add(folder);

            FormClosing += delegate
            {
                if (!ConfirmDiscardIfDirty()) return;
            };
            _tabs.Selecting += delegate(object s, TabControlCancelEventArgs e) { if (!ConfirmDiscardIfDirty()) e.Cancel = true; };
        }

        private Button MakeButton(string text, int x, Color back, Color fore)
        {
            return new Button
            {
                Text = text,
                Location = new Point(x, 14),
                Size = new Size(104, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = back,
                ForeColor = fore,
                FlatAppearance = { BorderSize = 0 },
                Cursor = Cursors.Hand,
            };
        }

        private void BuildPromptTab()
        {
            var tab = new TabPage("Main prompt  (prompt-inject.md)") { BackColor = Color.FromArgb(250, 250, 252) };

            var hint = new Label
            {
                Dock = DockStyle.Top,
                Height = 30,
                Padding = new Padding(8, 8, 0, 0),
                ForeColor = Color.FromArgb(120, 126, 140),
                Text = "Always injected. This is added to Pi's built-in system prompt -- it does not replace it.",
            };

            StyleEditor(_promptBox);
            _promptBox.TextChanged += delegate { if (!_loading) _dirtyPrompt = true; UpdateCounts(); };

            tab.Controls.Add(_promptBox);
            tab.Controls.Add(hint);
            _tabs.TabPages.Add(tab);
        }

        private void BuildPresetTab()
        {
            var tab = new TabPage("Presets  (presets\\*.md)") { BackColor = Color.FromArgb(250, 250, 252) };

            var bar = new Panel { Dock = DockStyle.Top, Height = 40 };
            _presetPicker.DropDownStyle = ComboBoxStyle.DropDownList;
            _presetPicker.Location = new Point(8, 8);
            _presetPicker.Width = 320;
            _presetPicker.SelectedIndexChanged += delegate { SwitchPreset(); };
            bar.Controls.Add(_presetPicker);

            var add = new Button { Text = "New preset", Location = new Point(336, 6), Size = new Size(96, 26), FlatStyle = FlatStyle.Flat };
            add.FlatAppearance.BorderSize = 0;
            add.BackColor = Color.FromArgb(232, 234, 240);
            add.Click += delegate { CreatePreset(); };
            bar.Controls.Add(add);

            var del = new Button { Text = "Delete", Location = new Point(440, 6), Size = new Size(80, 26), FlatStyle = FlatStyle.Flat };
            del.FlatAppearance.BorderSize = 0;
            del.BackColor = Color.FromArgb(232, 234, 240);
            del.Click += delegate { DeletePreset(); };
            bar.Controls.Add(del);

            var hint = new Label
            {
                Dock = DockStyle.Top,
                Height = 26,
                Padding = new Padding(8, 4, 0, 0),
                ForeColor = Color.FromArgb(120, 126, 140),
                Text = "Injected only when config.json's modelPresets match the active model. Edit the rules in Settings.",
            };

            StyleEditor(_presetBox);
            _presetBox.TextChanged += delegate { if (!_loading) _dirtyPreset = true; UpdateCounts(); };

            tab.Controls.Add(_presetBox);
            tab.Controls.Add(hint);
            tab.Controls.Add(bar);
            _tabs.TabPages.Add(tab);
        }

        private void BuildSettingsTab()
        {
            var tab = new TabPage("Settings  (config.json)") { BackColor = Color.FromArgb(250, 250, 252) };
            var host = new Panel { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(14) };

            var y = 10;
            AddRow(host, "Injection", ref y);
            _enabled.Text = "Enabled (inject at all)";
            _enabled.Location = new Point(20, y); _enabled.AutoSize = true;
            host.Controls.Add(_enabled); y += 30;

            host.Controls.Add(new Label { Text = "Position in the system prompt:", Location = new Point(20, y + 3), AutoSize = true });
            _position.DropDownStyle = ComboBoxStyle.DropDownList;
            _position.Items.AddRange(new object[] { "prepend", "append" });
            _position.Location = new Point(240, y); _position.Width = 140;
            host.Controls.Add(_position); y += 34;

            AddRow(host, "Auto-continue on truncation", ref y);
            _autoContinue.Text = "Send a continue message when output is truncated";
            _autoContinue.Location = new Point(20, y); _autoContinue.AutoSize = true;
            host.Controls.Add(_autoContinue); y += 30;

            host.Controls.Add(new Label { Text = "Max times:", Location = new Point(20, y + 3), AutoSize = true });
            _continueMax.Location = new Point(240, y); _continueMax.Width = 70;
            _continueMax.Minimum = 1; _continueMax.Maximum = 50;
            host.Controls.Add(_continueMax); y += 32;

            host.Controls.Add(new Label { Text = "Continue text:", Location = new Point(20, y + 3), AutoSize = true });
            _continueText.Location = new Point(240, y); _continueText.Width = 260;
            host.Controls.Add(_continueText); y += 40;

            AddRow(host, "Model presets", ref y);
            _presetInfo.Location = new Point(20, y);
            _presetInfo.Size = new Size(600, 20);
            _presetInfo.ForeColor = Color.FromArgb(120, 126, 140);
            host.Controls.Add(_presetInfo); y += 24;

            var rules = new ListBox { Location = new Point(20, y), Size = new Size(600, 130) };
            rules.Name = "rules";
            host.Controls.Add(rules); y += 140;

            var hint = new Label
            {
                Location = new Point(20, y),
                Size = new Size(700, 46),
                ForeColor = Color.FromArgb(120, 126, 140),
                Text = "Rules live in config.json (modelPresets). This editor preserves their order and\n" +
                       "content; edit that file directly or use /purge preset in Pi to change them.",
            };
            host.Controls.Add(hint);

            tab.Controls.Add(host);
            _tabs.TabPages.Add(tab);
        }

        private void AddRow(Panel host, string title, ref int y)
        {
            host.Controls.Add(new Label
            {
                Text = title,
                Location = new Point(8, y),
                AutoSize = true,
                Font = new Font("Segoe UI Semibold", 10f),
                ForeColor = Color.FromArgb(40, 44, 54),
            });
            y += 26;
        }

        private static void StyleEditor(TextBox box)
        {
            box.Dock = DockStyle.Fill;
            box.Multiline = true;
            box.ScrollBars = ScrollBars.Both;
            box.WordWrap = false;
            box.AcceptsTab = true;
            box.Font = new Font("Consolas", 10f);
            box.BackColor = Color.FromArgb(255, 255, 255);
            box.ForeColor = Color.FromArgb(28, 30, 38);
            box.BorderStyle = BorderStyle.None;
        }

        private void LoadAll()
        {
            _loading = true;
            try
            {
                _promptBox.Text = Store.Read(_store.InjectPath);
                _dirtyPrompt = false;

                _enabled.Checked = _config.Enabled;
                _position.SelectedItem = _config.Position;
                if (_position.SelectedIndex < 0) _position.SelectedIndex = 1;
                _autoContinue.Checked = _config.AutoContinue;
                _continueMax.Value = Math.Max(1, Math.Min(50, _config.ContinueMax));
                _continueText.Text = _config.ContinueText;

                FillPresetList();
                FillRules();

                _presetInfo.Text = string.IsNullOrEmpty(_config.ActivePreset)
                    ? "activePreset: auto -- matched by the rules below"
                    : "activePreset: " + _config.ActivePreset + " (rules ignored)";
            }
            finally { _loading = false; }
            UpdateCounts();
            _status.Text = "Loaded from " + _store.Dir;
        }

        private void FillPresetList()
        {
            _presetPicker.Items.Clear();
            foreach (var f in _store.PresetFiles())
                _presetPicker.Items.Add(Path.GetFileName(f));

            if (_presetPicker.Items.Count > 0)
            {
                var pick = 0;
                if (!string.IsNullOrEmpty(_config.ActivePreset))
                {
                    for (var i = 0; i < _presetPicker.Items.Count; i++)
                        if (string.Equals(_presetPicker.Items[i] as string, _config.ActivePreset, StringComparison.OrdinalIgnoreCase))
                            pick = i;
                }
                _presetPicker.SelectedIndex = pick;
            }
        }

        private void FillRules()
        {
            var rules = FindRules();
            if (rules == null) return;
            rules.Items.Clear();
            foreach (var pair in _config.ModelPresets)
                rules.Items.Add(pair[0] + "   ->   " + pair[1]);
            if (rules.Items.Count == 0) rules.Items.Add("(no rules -- presets are never injected)");
        }

        private ListBox FindRules()
        {
            foreach (TabPage page in _tabs.TabPages)
                foreach (Control c in page.Controls)
                {
                    var host = c as Panel;
                    if (host == null) continue;
                    foreach (Control inner in host.Controls)
                        if (inner is ListBox && inner.Name == "rules") return (ListBox)inner;
                }
            return null;
        }

        private void SwitchPreset()
        {
            SavePresetIfDirty();
            var name = _presetPicker.SelectedItem as string;
            if (string.IsNullOrEmpty(name)) { _presetBox.Text = ""; _currentPresetFile = null; return; }

            _currentPresetFile = Path.Combine(_store.PresetsDir, name);
            _loading = true;
            try { _presetBox.Text = Store.Read(_currentPresetFile); }
            finally { _loading = false; }
            _dirtyPreset = false;
            UpdateCounts();
        }

        private void CreatePreset()
        {
            var name = Prompt.Show(this, "New preset file name (without .md):", "new-preset");
            if (string.IsNullOrEmpty(name)) return;
            if (!name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) name += ".md";
            var path = Path.Combine(_store.PresetsDir, name);
            if (File.Exists(path)) { _status.Text = "Already exists: " + name; return; }

            Store.AtomicWrite(path, "");
            FillPresetList();
            _presetPicker.SelectedItem = name;
            _status.Text = "Created " + name + " -- add a modelPresets rule in Settings for it to be used.";
        }

        private void DeletePreset()
        {
            var name = _presetPicker.SelectedItem as string;
            if (string.IsNullOrEmpty(name)) return;
            if (MessageBox.Show(this, "Delete " + name + "?", Program.AppTitle,
                    MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;

            var path = Path.Combine(_store.PresetsDir, name);
            try
            {
                File.Delete(path);
                _currentPresetFile = null;
                _presetBox.Text = "";
                FillPresetList();
                _status.Text = "Deleted " + name;
            }
            catch (Exception ex) { _status.Text = "Delete failed: " + ex.Message; }
        }

        private void SavePresetIfDirty()
        {
            if (!_dirtyPreset || string.IsNullOrEmpty(_currentPresetFile)) return;
            try
            {
                Store.AtomicWrite(_currentPresetFile, _presetBox.Text);
                _dirtyPreset = false;
            }
            catch (Exception ex) { _status.Text = "Preset save failed: " + ex.Message; }
        }

        private void SaveAll(bool announce)
        {
            try
            {
                Store.AtomicWrite(_store.InjectPath, _promptBox.Text);
                _dirtyPrompt = false;

                SavePresetIfDirty();

                _config.Enabled = _enabled.Checked;
                _config.Position = (_position.SelectedItem as string) ?? "append";
                _config.AutoContinue = _autoContinue.Checked;
                _config.ContinueMax = (int)_continueMax.Value;
                _config.ContinueText = _continueText.Text;
                Store.AtomicWrite(_store.ConfigPath, _config.ToJson());

                UpdateCounts();
                if (announce) _status.Text = "Saved. Applies on the next turn -- no reload needed.";
            }
            catch (Exception ex)
            {
                _status.Text = "Save failed: " + ex.Message;
                if (announce) MessageBox.Show(this, ex.Message, "Save failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private bool ConfirmDiscardIfDirty()
        {
            if (!_dirtyPrompt && !_dirtyPreset) return true;
            var r = MessageBox.Show(this, "Save changes before leaving?", Program.AppTitle,
                MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (r == DialogResult.Cancel) return false;
            if (r == DialogResult.Yes) SaveAll(false);
            return true;
        }

        private void UpdateCounts()
        {
            var presets = _store.PresetFiles().Length;
            _counts.Text = string.Format(
                "prompt-inject.md: {0:N0} chars   |   current preset: {1:N0} chars   |   {2} preset file(s)",
                _promptBox.Text.Length, _presetBox.Text.Length, presets);
        }

        private static void Reveal(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                Process.Start("explorer.exe", "\"" + dir + "\"");
            }
            catch { }
        }
    }

    /// <summary>Minimal single-line input dialog (WinForms has none built in).</summary>
    internal static class Prompt
    {
        internal static string Show(IWin32Window owner, string label, string initial)
        {
            using (var form = new Form())
            {
                form.Text = Program.AppTitle;
                form.ClientSize = new Size(420, 130);
                form.StartPosition = FormStartPosition.CenterParent;
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.MinimizeBox = false; form.MaximizeBox = false;
                form.Font = new Font("Segoe UI", 9f);

                form.Controls.Add(new Label { Text = label, Location = new Point(14, 14), AutoSize = true });
                var box = new TextBox { Text = initial, Location = new Point(14, 40), Width = 390 };
                form.Controls.Add(box);

                var ok = new Button { Text = "OK", DialogResult = DialogResult.OK, Location = new Point(240, 78), Size = new Size(78, 30) };
                var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Location = new Point(326, 78), Size = new Size(78, 30) };
                form.Controls.Add(ok); form.Controls.Add(cancel);
                form.AcceptButton = ok; form.CancelButton = cancel;

                return form.ShowDialog(owner) == DialogResult.OK ? box.Text.Trim() : null;
            }
        }
    }
}
