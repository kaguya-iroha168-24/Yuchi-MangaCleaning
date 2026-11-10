use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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
    exiting: std::sync::atomic::AtomicBool,
}

#[cfg(windows)]
static INSTANCE_MUTEX: Mutex<Option<isize>> = Mutex::new(None);

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
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() { return; }
        std::thread::sleep(Duration::from_millis(100));
    }
    if child.try_wait().ok().flatten().is_none() {
        #[cfg(windows)] {
            // `child` still holds its open Win32 kernel process HANDLE here,
            // so the OS cannot have reassigned `child.id()` to another process.
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .output();
        }
        let _ = child.kill();
    }
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

fn ensure_backend_process(state: &BackendState, origin: Option<&str>) -> Result<(u16, Session, u32), String> {
    let mut guard = state.running.lock().map_err(|_| "Backend state unavailable")?;
    if let Some((child, session)) = guard.as_mut() {
        if child.try_wait().map_err(|error| error.to_string())?.is_none() {
            let port = tauri::Url::parse(&session.base_url).ok().and_then(|url| url.port()).ok_or("Backend address unavailable")?;
            let pid = child.id();
            return Ok((port, session.clone(), pid));
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
        .args(["-m", "backend.main", "--port", &port.to_string()])
        .env("YUCHI_TAURI_TOKEN", &token)
        .env("YUCHI_PARENT_PID", std::process::id().to_string())
        .env("PYTHONPYCACHEPREFIX", cache.join("pycache"))
        .env("YUCHI_LABS_SETTINGS_DIR", cache.join("settings"))
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(orig) = origin {
        command.env("YUCHI_FRONTEND_ORIGIN", orig);
    }
    #[cfg(windows)] {
        if let Some(ctime) = current_process_creation_filetime() {
            command.env("YUCHI_PARENT_CREATION_FILETIME", ctime.to_string());
        }
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command.spawn().map_err(|error| format!("Backend failed to start: {error}"))?;
    let pid = child.id();
    let session = Session { base_url: format!("http://127.0.0.1:{port}"), token };
    *guard = Some((child, session.clone()));
    Ok((port, session, pid))
}

fn wait_for_backend_healthy(state: &BackendState, port: u16, session: &Session, pid: u32) -> Result<Session, String> {
    let cache = workspace()?.join(".cache");
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if state.exiting.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Application is shutting down.".into());
        }
        if health(port, &session.token) {
            // Safe measurement marker: no session token or request headers.
            let _ = std::fs::write(
                cache.join("backend-ready.json"),
                format!("{{\"backendPid\":{},\"phase\":\"authenticated_backend_healthy\"}}", pid),
            );
            return Ok(session.clone());
        }
        if let Ok(mut guard) = state.running.lock() {
            match guard.as_mut() {
                Some((child, _)) if child.id() == pid => {
                    if child.try_wait().map_err(|error| error.to_string())?.is_some() {
                        *guard = None;
                        return Err("Python backend exited during startup. Check the local runtime and dependencies.".into());
                    }
                }
                _ => return Err("Backend session was replaced or stopped.".into()),
            }
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    if let Ok(mut guard) = state.running.lock() {
        if guard.as_ref().map(|(c, _)| c.id()) == Some(pid) {
            if let Some((mut child, s)) = guard.take() {
                stop_backend(&mut child, &s);
            }
        }
    }
    Err("Python backend did not pass its health check in 20 seconds.".into())
}

#[tauri::command]
async fn bootstrap(window: tauri::WebviewWindow, state: State<'_, BackendState>) -> Result<Session, String> {
    // Use the actual native URL, including Tauri CLI's built-in dev server.
    // No token or caller-supplied origin is accepted from React.
    let origin = frontend_origin(&window.url().map_err(|error| error.to_string())?)?;
    let (port, session, pid) = ensure_backend_process(&state, Some(&origin))?;
    wait_for_backend_healthy(&state, port, &session, pid)
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

#[cfg(windows)]
fn current_process_creation_filetime() -> Option<u64> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn GetProcessTimes(process: isize, creation: *mut u64, exit: *mut u64, kernel: *mut u64, user: *mut u64) -> i32;
    }
    unsafe {
        let (mut ctime, mut etime, mut ktime, mut utime) = (0u64, 0u64, 0u64, 0u64);
        if GetProcessTimes(GetCurrentProcess(), &mut ctime, &mut etime, &mut ktime, &mut utime) != 0 {
            Some(ctime)
        } else {
            None
        }
    }
}

#[cfg(windows)]
fn process_image_path(pid: u32) -> Option<PathBuf> {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn QueryFullProcessImageNameW(process: isize, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    unsafe {
        let handle = OpenProcess(0x1000, 0, pid);
        if handle == 0 { return None; }
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 || size == 0 { return None; }
        let raw = String::from_utf16_lossy(&buf[..size as usize]);
        std::fs::canonicalize(&raw).ok().or_else(|| Some(PathBuf::from(raw)))
    }
}

#[cfg(windows)]
fn find_and_focus_same_exe_window() -> (Option<u32>, bool) {
    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(cb: unsafe extern "system" fn(isize, isize) -> i32, lparam: isize) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn IsWindowEnabled(hwnd: isize) -> i32;
        fn IsIconic(hwnd: isize) -> i32;
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn GetClassNameW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
    }
    let self_pid = std::process::id();
    let Some(self_exe) = std::env::current_exe().ok().and_then(|p| std::fs::canonicalize(&p).ok().or(Some(p))) else {
        return (None, false);
    };
    struct WindowProbe {
        self_pid: u32,
        self_exe: PathBuf,
        matched_pid: Option<u32>,
        focused_hwnd: isize,
    }
    unsafe extern "system" fn callback(hwnd: isize, lparam: isize) -> i32 {
        let probe = &mut *(lparam as *mut WindowProbe);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != 0 && pid != probe.self_pid && IsWindowVisible(hwnd) != 0 && IsWindowEnabled(hwnd) != 0 {
            let mut cls = [0u16; 64];
            let len = GetClassNameW(hwnd, cls.as_mut_ptr(), cls.len() as i32);
            if len > 0 && String::from_utf16_lossy(&cls[..len as usize]) == "Tauri Window" {
                if process_image_path(pid).as_ref() == Some(&probe.self_exe) {
                    probe.matched_pid = Some(pid);
                    probe.focused_hwnd = hwnd;
                    return 0;
                }
            }
        }
        1
    }
    let mut probe = WindowProbe {
        self_pid,
        self_exe: self_exe.clone(),
        matched_pid: None,
        focused_hwnd: 0,
    };
    unsafe {
        EnumWindows(callback, &mut probe as *mut WindowProbe as isize);
        if probe.focused_hwnd != 0 {
            if IsIconic(probe.focused_hwnd) != 0 {
                let _ = ShowWindow(probe.focused_hwnd, 9); // SW_RESTORE
            }
            let _ = SetForegroundWindow(probe.focused_hwnd);
            return (probe.matched_pid, true);
        }
        let snap = CreateToolhelp32Snapshot(0x00000002, 0);
        if snap != -1 && snap != 0 {
            let mut entry: ProcessEntry32W = std::mem::zeroed();
            entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                let pid = entry.th32_process_id;
                if pid != 0 && pid != self_pid && process_image_path(pid).as_ref() == Some(&self_exe) {
                    CloseHandle(snap);
                    return (Some(pid), false);
                }
                ok = Process32NextW(snap, &mut entry);
            }
            CloseHandle(snap);
        }
    }
    (None, false)
}

#[cfg(windows)]
fn acquire_instance_mutex(root: &std::path::Path) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attrs: *const core::ffi::c_void, initial_owner: i32, name: *const u16) -> isize;
        fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
        fn CloseHandle(handle: isize) -> i32;
    }
    let canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let key = canon.to_string_lossy().to_lowercase();
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in key.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let mut wide_name: Vec<u16> = format!("Local\\YuchiLabsMangaClean_{hash:016x}").encode_utf16().collect();
    wide_name.push(0);
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, wide_name.as_ptr());
        if handle == 0 {
            return true;
        }
        let wait = WaitForSingleObject(handle, 400);
        if wait == 0x00000000 || wait == 0x00000080 {
            if let Ok(mut guard) = INSTANCE_MUTEX.lock() {
                *guard = Some(handle);
            }
            true
        } else {
            CloseHandle(handle);
            false
        }
    }
}

#[cfg(windows)]
fn release_instance_mutex() {
    #[link(name = "kernel32")]
    extern "system" {
        fn ReleaseMutex(handle: isize) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    if let Ok(mut guard) = INSTANCE_MUTEX.lock() {
        if let Some(handle) = guard.take() {
            unsafe {
                let _ = ReleaseMutex(handle);
                let _ = CloseHandle(handle);
            }
        }
    }
}

#[cfg(windows)]
fn record_and_notify_startup_guard(
    root: &std::path::Path,
    status: &str,
    reason: &str,
    existing_pid: Option<u32>,
    focused: bool,
    message: &str,
) {
    let cache = root.join(".cache");
    let _ = std::fs::create_dir_all(&cache);
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let report = serde_json::json!({
        "status": status,
        "reason": reason,
        "existingPid": existing_pid,
        "focusedExistingWindow": focused,
        "guardedPid": std::process::id(),
        "message": message,
        "timestampMs": ts,
    });
    let _ = std::fs::write(
        cache.join("startup-guard.json"),
        serde_json::to_string_pretty(&report).unwrap_or_default(),
    );
    eprintln!("[Yuchi Labs Startup Guard] {message}");
    if !focused && std::env::var("YUCHI_SUPPRESS_STARTUP_DIALOG").ok().as_deref() != Some("1") {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxTimeoutW(
                hwnd: isize,
                text: *const u16,
                caption: *const u16,
                utype: u32,
                wlanguage: u16,
                milliseconds: u32,
            ) -> i32;
        }
        let mut text_w: Vec<u16> = message.encode_utf16().collect();
        text_w.push(0);
        let mut title_w: Vec<u16> = "Yuchi Labs — MangaClean Atelier".encode_utf16().collect();
        title_w.push(0);
        unsafe {
            // MB_OK (0) | MB_ICONINFORMATION (0x40) | MB_SETFOREGROUND (0x10000)
            let _ = MessageBoxTimeoutW(0, text_w.as_ptr(), title_w.as_ptr(), 0x00010040, 0, 2500);
        }
    }
}

fn check_webview_profile_available(data: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
    let lock_file = data.join("EBWebView/Default/LOCK");
    if lock_file.is_file() {
        let mut last_err = None;
        for _ in 0..5 {
            match std::fs::OpenOptions::new().read(true).write(true).open(&lock_file) {
                Ok(_handle) => return Ok(()),
                Err(err) => {
                    last_err = Some(err.to_string());
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
        if let Some(err) = last_err {
            return Err(format!("EBWebView/Default/LOCK is in use: {err}"));
        }
    }
    Ok(())
}

fn shutdown_owned_backend(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<BackendState>() {
        state.exiting.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut guard) = state.running.lock() {
            if let Some((mut child, session)) = guard.take() {
                stop_backend(&mut child, &session);
            }
        }
    }
    if let Ok(root) = workspace() {
        let _ = std::fs::remove_file(root.join(".cache/backend-ready.json"));
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(BackendState::default())
        .setup(|app| {
            let root = workspace().map_err(std::io::Error::other)?;
            #[cfg(windows)]
            if !acquire_instance_mutex(&root) {
                let (existing_pid, focused) = find_and_focus_same_exe_window();
                let msg = if focused {
                    format!(
                        "MangaClean Atelier sudah berjalan (PID {}). Jendela yang terbuka telah difokuskan; instance baru keluar dengan aman agar perubahan yang belum disimpan tetap terlindungi.",
                        existing_pid.unwrap_or(0)
                    )
                } else {
                    format!(
                        "MangaClean Atelier sudah berjalan atau sedang memuat dari folder ini (PID {}). Instance baru keluar dengan aman tanpa menghentikan proses yang ada.",
                        existing_pid.unwrap_or(0)
                    )
                };
                record_and_notify_startup_guard(
                    &root,
                    "blocked_already_running",
                    if focused { "existing_window_focused" } else { "existing_instance_active" },
                    existing_pid,
                    focused,
                    &msg,
                );
                std::process::exit(0);
            }
            let data = root.join(".cache/webview");
            if let Err(lock_err) = check_webview_profile_available(&data) {
                #[cfg(windows)]
                {
                    let (existing_pid, focused) = find_and_focus_same_exe_window();
                    let msg = format!(
                        "Profil WebView (.cache/webview) sedang digunakan atau terkunci ({lock_err}). Instance baru keluar dengan aman tanpa menghentikan proses lain agar data yang belum disimpan tetap aman."
                    );
                    record_and_notify_startup_guard(
                        &root,
                        "blocked_webview_locked",
                        "webview_profile_in_use",
                        existing_pid,
                        focused,
                        &msg,
                    );
                    release_instance_mutex();
                    std::process::exit(0);
                }
                #[cfg(not(windows))]
                return Err(std::io::Error::other(lock_err).into());
            }
            #[cfg(not(debug_assertions))]
            if let Some(state) = app.try_state::<BackendState>() {
                if let Ok((port, session, pid)) = ensure_backend_process(&state, None) {
                    let app_handle = app.handle().clone();
                    std::thread::spawn(move || {
                        if let Some(st) = app_handle.try_state::<BackendState>() {
                            let _ = wait_for_backend_healthy(&st, port, &session, pid);
                        }
                    });
                }
            }
            let config = app.config().app.windows[0].clone();
            if let Err(error) = tauri::WebviewWindowBuilder::from_config(app, &config)
                .and_then(|builder| builder.data_directory(data.clone()).build())
            {
                shutdown_owned_backend(app.handle());
                #[cfg(windows)]
                {
                    let (existing_pid, focused) = find_and_focus_same_exe_window();
                    let msg = format!(
                        "Profil WebView (.cache/webview) sedang digunakan atau terkunci ({error}). Instance baru keluar dengan aman tanpa menghentikan proses lain agar data yang belum disimpan tetap aman."
                    );
                    record_and_notify_startup_guard(
                        &root,
                        "blocked_webview_locked",
                        "webview_profile_in_use",
                        existing_pid,
                        focused,
                        &msg,
                    );
                    release_instance_mutex();
                    std::process::exit(0);
                }
                #[cfg(not(windows))]
                return Err(error.into());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bootstrap])
        .build(tauri::generate_context!())
        .expect("Failed to build Yuchi Labs Tauri")
        .run(|app, event| {
            match event {
                tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::Destroyed, .. } => {
                    shutdown_owned_backend(app);
                }
                tauri::RunEvent::Exit => {
                    shutdown_owned_backend(app);
                    #[cfg(windows)]
                    release_instance_mutex();
                }
                _ => {}
            }
        });
}
