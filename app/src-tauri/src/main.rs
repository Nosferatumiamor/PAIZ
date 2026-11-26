// PAIZ — Tauri desktop shell.
//
// The Rust layer is intentionally tiny: it picks a free local port, starts the
// existing zero-dependency Node backend, waits for it to listen, then points the
// WebView at it. The end of the process kills the Node child.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{Manager, RunEvent, WebviewWindow};

/// Tue le processus Node ET tout ce qu'il a lancé (moteur WeightStream, œil…), pour ne rien laisser tourner.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

type ChildSlot = Arc<Mutex<Option<Child>>>;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

/// `%APPDATA%\PAIZ` on Windows, `~/.config/PAIZ` elsewhere.
fn paiz_root() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return PathBuf::from(appdata).join("PAIZ");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join(".config").join("PAIZ");
        }
    }
    PathBuf::from(".paiz")
}

fn data_dir() -> PathBuf {
    match std::env::var("PAIZ_HOME") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => paiz_root().join("data"),
    }
}

fn log(message: &str) {
    let root = paiz_root();
    let _ = fs::create_dir_all(&root);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("server.log"))
    {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "[{stamp}] {message}");
    }
}

fn tail_log(lines: usize) -> String {
    let Ok(text) = fs::read_to_string(paiz_root().join("server.log")) else {
        return String::new();
    };
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}

/// Tauri's resource resolver may hand back Windows verbatim paths (`\\?\D:\…`).
/// Node's ESM entry-point resolver chokes on those when passed as an argument,
/// so strip the namespace prefix while keeping UNC paths intact.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

/// The app payload: bundled resource in release, repo folder in dev.
fn resolve_app_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(value) = std::env::var("PAIZ_APP_DIR") {
        let dir = PathBuf::from(value);
        if dir.join("src").join("cli.js").is_file() {
            return strip_verbatim(dir);
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        let dir = resources.join("app");
        if dir.join("src").join("cli.js").is_file() {
            return strip_verbatim(dir);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    strip_verbatim(dev.canonicalize().unwrap_or(dev))
}

/// `PAIZ_NODE` override → bundled node.exe → staged node.exe → PATH.
fn resolve_node(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(value) = std::env::var("PAIZ_NODE") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        let candidate = resources.join("node.exe");
        if candidate.is_file() {
            return strip_verbatim(candidate);
        }
    }
    let staged = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("node.exe");
    if staged.is_file() {
        return strip_verbatim(staged);
    }
    PathBuf::from("node")
}

// Port FIXE de préférence : la page est servie sur http://127.0.0.1:<port>, et le stockage du navigateur (réglages des bips,
// visages, voix, choix des tâches…) est rangé par adresse. Un port tiré au hasard à chaque lancement les faisait tous oublier.
const PREFERRED_PORT: u16 = 47823;

fn free_port() -> u16 {
    if TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).is_ok() {
        return PREFERRED_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(7788)
}

fn wait_ready(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    while start.elapsed() < timeout {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

fn spawn_server(app: &tauri::AppHandle, port: u16) -> Result<Child, String> {
    let app_dir = resolve_app_dir(app);
    let node = resolve_node(app);
    let data = data_dir();
    let log_path = paiz_root().join("server.log");
    let cli = app_dir.join("src").join("cli.js");

    if !cli.is_file() {
        return Err(format!(
            "Le moteur PAIZ est introuvable.\nFichier attendu : {}\n\nRéinstalle PAIZ ou définis PAIZ_APP_DIR.",
            cli.display()
        ));
    }

    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Impossible de créer {} : {err}", parent.display()))?;
    }
    fs::create_dir_all(&data)
        .map_err(|err| format!("Impossible de créer {} : {err}", data.display()))?;

    log(&format!(
        "Démarrage — node={} app={} data={} port={}",
        node.display(),
        app_dir.display(),
        data.display(),
        port
    ));

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("Impossible d'ouvrir {} : {err}", log_path.display()))?;
    let stderr = stdout
        .try_clone()
        .map_err(|err| format!("Journal indisponible : {err}"))?;

    let mut command = Command::new(&node);
    command
        .arg(&cli)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .arg("--no-open")
        .current_dir(&app_dir)
        .env("PAIZ_HOME", &data)
        .env("PAIZ_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn().map_err(|err| {
        format!(
            "Impossible de lancer Node.js.\nBinaire essayé : {}\n{err}\n\nEn développement, installe Node.js ≥ 24 ou définis PAIZ_NODE.",
            node.display()
        )
    })
}

fn js_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn eval_retry(window: &WebviewWindow, js: &str) {
    for _ in 0..20 {
        if window.eval(js).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn show_error(window: &WebviewWindow, message: &str) {
    log(&format!("ERREUR — {message}"));
    eprintln!("{message}");
    thread::sleep(Duration::from_millis(350));
    let js = format!("window.paizError && window.paizError({});", js_quote(message));
    eval_retry(window, &js);
}

fn main() {
    let child: ChildSlot = Arc::new(Mutex::new(None));
    let exiting = Arc::new(AtomicBool::new(false));
    let setup_child = Arc::clone(&child);
    let setup_exiting = Arc::clone(&exiting);
    let exit_child = Arc::clone(&child);
    let exit_exiting = Arc::clone(&exiting);

    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let window = app.get_webview_window("main");
            let port = free_port();
            let slot = Arc::clone(&setup_child);
            let exiting = Arc::clone(&setup_exiting);

            thread::spawn(move || {
                let Some(window) = window else {
                    log("Fenêtre principale introuvable");
                    return;
                };

                match spawn_server(&handle, port) {
                    Ok(process) => {
                        // Store the child under the same lock used at exit, so a
                        // window closed during startup can never leak Node.
                        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
                        if exiting.load(Ordering::SeqCst) {
                            drop(guard);
                            let mut process = process;
                            let _ = process.kill();
                            let _ = process.wait();
                            return;
                        }
                        *guard = Some(process);
                        drop(guard);

                        let _ = window.eval(
                            "window.paizProgress && window.paizProgress('Moteur Node.js lancé…');",
                        );

                        if wait_ready(port, STARTUP_TIMEOUT) {
                            // PAIZ_START_PATH (facultatif) : page d'arrivée, ex. « /nouvelle » pour la nouvelle interface (lanceur PAIZ-v2.bat)
                            let start_path = std::env::var("PAIZ_START_PATH")
                                .ok()
                                .filter(|p| p.starts_with('/') && p.len() < 64 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '/' || c == '-' || c == '_'))
                                .unwrap_or_default();
                            let url = format!("http://127.0.0.1:{port}{start_path}");
                            let js = format!("window.location.replace({});", js_quote(&url));
                            if let Err(err) = window.eval(&js) {
                                show_error(
                                    &window,
                                    &format!("Impossible d'ouvrir l'interface ({err})."),
                                );
                            }
                        } else {
                            let details = tail_log(10);
                            let mut message = format!(
                                "Le serveur local n'a pas répondu sur 127.0.0.1:{port} après {} s.",
                                STARTUP_TIMEOUT.as_secs()
                            );
                            if !details.is_empty() {
                                message.push_str("\n\nDernières lignes du journal :\n");
                                message.push_str(&details);
                            }
                            show_error(&window, &message);
                        }
                    }
                    Err(err) => {
                        let details = tail_log(10);
                        let mut message = err;
                        if !details.is_empty() {
                            message.push_str("\n\nDernières lignes du journal :\n");
                            message.push_str(&details);
                        }
                        show_error(&window, &message);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Erreur au démarrage de PAIZ")
        .run(move |_app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                exit_exiting.store(true, Ordering::SeqCst);
                if let Ok(mut guard) = exit_child.lock() {
                    if let Some(mut process) = guard.take() {
                        log("Arrêt du serveur PAIZ (et du moteur, de l'œil… qu'il a lancés)");
                        kill_tree(process.id());
                        let _ = process.kill();
                        let _ = process.wait();
                    }
                }
            }
        });
}
