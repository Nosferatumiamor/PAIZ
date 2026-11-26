// Fenêtre native Windows « choisir un dossier » (avec « Créer un nouveau dossier »). Aucune dépendance : un script PowerShell en mode STA.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export function pickFolder(start) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Le sélecteur de dossier n’est disponible que sous Windows.'));
  const init = start && fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : '';
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.StartPosition = 'CenterScreen'; $owner.Opacity = 0; $owner.Size = New-Object System.Drawing.Size(1,1)
$owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choisir le dossier du projet'
$d.ShowNewFolderButton = $true
$d.UseDescriptionForTitle = $true
if ($env:PAIZ_PICK_START) { $d.SelectedPath = $env:PAIZ_PICK_START }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
$owner.Close()`;
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-STA', '-Command', script], {
      env: { ...process.env, PAIZ_PICK_START: init }, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { err += b; });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve(out.trim() || null) : reject(new Error(err.trim().slice(0, 300) || `sélecteur de dossier : code ${code}`))));
  });
}

// Fenêtre native « choisir des fichiers » (plusieurs à la fois), même principe. Renvoie la liste des chemins, vide si annulé.
export function pickFiles(start) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Le sélecteur de fichiers n’est disponible que sous Windows.'));
  const init = start && fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : '';
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.StartPosition = 'CenterScreen'; $owner.Opacity = 0; $owner.Size = New-Object System.Drawing.Size(1,1)
$owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Fichiers à donner à la tâche'
$d.Multiselect = $true
if ($env:PAIZ_PICK_START) { $d.InitialDirectory = $env:PAIZ_PICK_START }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write(($d.FileNames -join [char]10)) }
$owner.Close()`;
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-STA', '-Command', script], { env: { ...process.env, PAIZ_PICK_START: init }, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { err += b; });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve(out.split('\n').map((x) => x.trim()).filter(Boolean)) : reject(new Error(err.trim().slice(0, 300) || `sélecteur de fichiers : code ${code}`))));
  });
}
