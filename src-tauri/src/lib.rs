use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, State};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Session {
    base_url: String,
    token: String,
}

#[derive(Default)]
struct BackendState {
    running: Mutex<Option<(Child, Session)>>,
}

fn workspace() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Workspace path unavailable")?
        .to_path_buf();
    #[cfg(not(debug_assertions))]
    let root = std::env::current_exe().map_err(|error| error.to_string())?
        .parent().ok_or("Application directory unavailable")?.join("runtime/app");
    if !root.join("backend/main.py").is_file() {
        return Err("Application backend is missing. Keep the runtime folder beside MangaClean.exe.".into());
    }
    Ok(root)
}

fn health(port: u16, token: &str) -> bool {
    let mut stream = match TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(350),
    ) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(350)));
    let request = format!(
        "GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() { return false; }
    let mut bytes = Vec::new();
    if stream.read_to_end(&mut bytes).is_err() { return false; }
    let response = String::from_utf8_lossy(&bytes);
    response.starts_with("HTTP/1.1 200") && response.contains("\"identity\":\"Yuchi Labs Tauri\"")
}

fn stop_backend(child: &mut Child, session: &Session) {
    let address = session.base_url.trim_start_matches("http://");
    if let Ok(mut stream) = TcpStream::connect(address) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let request = format!(
            "POST /v1/shutdown HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            session.token
        );
        let _ = stream.write_all(request.as_bytes());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() { return; }
        std::thread::sleep(Duration::from_millis(100));
    }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))] { let _ = child.kill(); }
    let _ = child.wait();
}

fn frontend_origin(url: &tauri::Url) -> Result<String, String> {
    let origin = url.origin().ascii_serialization();
    let local_dev = url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some();
    if local_dev || matches!(origin.as_str(), "http://tauri.localhost" | "https://tauri.localhost") {
        Ok(origin)
    } else if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        Ok("tauri://localhost".into())
    } else {
        Err("Backend access requires the application's local WebView origin.".into())
    }
}

#[tauri::command]
async fn bootstrap(window: tauri::WebviewWindow, state: State<'_, BackendState>) -> Result<Session, String> {
    // Use the actual native URL, including Tauri CLI's built-in dev server.
    // No token or caller-supplied origin is accepted from React.
    let origin = frontend_origin(&window.url().map_err(|error| error.to_string())?)?;
    let mut guard = state.running.lock().map_err(|_| "Backend state unavailable")?;
    if let Some((child, session)) = guard.as_mut() {
        if child.try_wait().map_err(|error| error.to_string())?.is_none() {
            let port = tauri::Url::parse(&session.base_url).ok().and_then(|url| url.port()).ok_or("Backend address unavailable")?;
            return if health(port, &session.token) { Ok(session.clone()) }
                else { Err("Backend is not ready. Retry Reconnect; the current project has not been restarted.".into()) };
        }
        *guard = None;
    }
    let root = workspace()?;
    #[cfg(debug_assertions)]
    let python = root.join(".venv-standalone/Scripts/python.exe");
    #[cfg(not(debug_assertions))]
    let python = root.parent().ok_or("Runtime directory unavailable")?.join("python/python.exe");
    if !python.is_file() {
        return Err("Python environment missing. Run setup first in the Tauri workspace.".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    drop(listener);
    let token = uuid::Uuid::new_v4().simple().to_string();
    let cache = root.join(".cache");
    let temp = cache.join("tmp");
    std::fs::create_dir_all(&temp).map_err(|error| error.to_string())?;
    let mut command = Command::new(python);
    command.current_dir(&root)
        .args(["-B", "-m", "backend.main", "--port", &port.to_string()])
        .env("YUCHI_TAURI_TOKEN", &token)
        .env("YUCHI_FRONTEND_ORIGIN", &origin)
        .env("PYTHONPYCACHEPREFIX", cache.join("pycache"))
        .env("YUCHI_LABS_SETTINGS_DIR", cache.join("settings"))
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|error| format!("Backend failed to start: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if health(port, &token) {
            // Safe measurement marker: no session token or request headers.
            let _ = std::fs::write(cache.join("backend-ready.json"),
                format!("{{\"backendPid\":{},\"phase\":\"authenticated_backend_healthy\"}}", child.id()));
            let session = Session { base_url: format!("http://127.0.0.1:{port}"), token };
            *guard = Some((child, session.clone()));
            return Ok(session);
        }
        if child.try_wait().map_err(|error| error.to_string())?.is_some() {
            return Err("Python backend exited during startup. Check the local runtime and dependencies.".into());
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    let session = Session { base_url: format!("http://127.0.0.1:{port}"), token };
    stop_backend(&mut child, &session);
    Err("Python backend did not pass its health check in 20 seconds.".into())
}

#[cfg(test)]
mod tests {
    use super::frontend_origin;
    #[test]
    fn actual_native_origins_only() {
        for (url, expected) in [
            ("http://127.0.0.1:49173/index.html", "http://127.0.0.1:49173"),
            ("http://tauri.localhost/", "http://tauri.localhost"),
            ("https://tauri.localhost/", "https://tauri.localhost"),
            ("tauri://localhost/", "tauri://localhost"),
        ] { assert_eq!(frontend_origin(&tauri::Url::parse(url).unwrap()).unwrap(), expected); }
        for url in ["https://example.com/", "http://127.0.0.1/", "http://localhost:49173/", "http://192.168.1.2:49173/"] {
            assert!(frontend_origin(&tauri::Url::parse(url).unwrap()).is_err());
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data = workspace().map_err(std::io::Error::other)?.join(".cache/webview");
            std::fs::create_dir_all(&data)?;
            let config = app.config().app.windows[0].clone();
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .data_directory(data)
                .build()?;
            Ok(())
        })
        .manage(BackendState::default())
        .invoke_handler(tauri::generate_handler![bootstrap])
        .build(tauri::generate_context!())
        .expect("Failed to build Yuchi Labs Tauri")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<BackendState>() {
                    if let Ok(mut guard) = state.running.lock() {
                        if let Some((mut child, session)) = guard.take() {
                            stop_backend(&mut child, &session);
                        }
                    }
                }
            }
        });
}
