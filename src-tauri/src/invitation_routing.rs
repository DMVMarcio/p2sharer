//! Normal launches remain independent; only invitations are forwarded to a live instance.
const MAX_INVITATION_BYTES: usize = 16_384;

fn invitation(bytes: &[u8]) -> Option<&str> {
    if bytes.is_empty() || bytes.len() > MAX_INVITATION_BYTES {
        return None;
    }
    let raw = std::str::from_utf8(bytes).ok()?;
    let url = tauri::Url::parse(raw).ok()?;
    if url.scheme() != "p2sharer"
        || !matches!(url.host_str(), Some("invite" | "convite"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().len() <= 1
    {
        return None;
    }
    Some(raw)
}

#[cfg(windows)]
mod desktop {
    use super::*;
    use tauri::Manager;
    use tauri_plugin_deep_link::DeepLinkExt;
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
            System::{DataExchange::COPYDATASTRUCT, LibraryLoader::GetModuleHandleW},
            UI::WindowsAndMessaging::*,
        },
    };
    const CLASS: PCWSTR = w!("P2Sharer.InvitationRouter.v1");
    const MESSAGE_TAG: usize = 0x50325349;
    type Receiver = Box<dyn Fn(String) + Send + Sync>;

    unsafe fn copy_invitation(lparam: LPARAM) -> Option<String> {
        let data = (lparam.0 as *const COPYDATASTRUCT).as_ref()?;
        if data.dwData != MESSAGE_TAG
            || data.cbData == 0
            || data.cbData as usize > MAX_INVITATION_BYTES
            || data.lpData.is_null()
        {
            return None;
        }
        let bytes = std::slice::from_raw_parts(data.lpData.cast::<u8>(), data.cbData as usize);
        invitation(bytes).map(str::to_owned)
    }

    unsafe extern "system" fn receiver_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_CREATE => {
                let creation = &*(lparam.0 as *const CREATESTRUCTW);
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, creation.lpCreateParams as isize);
                LRESULT(0)
            }
            WM_COPYDATA => {
                let receiver = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Receiver;
                if let (Some(receiver), Some(url)) = (receiver.as_ref(), copy_invitation(lparam)) {
                    receiver(url);
                    return LRESULT(1);
                }
                LRESULT(0)
            }
            WM_NCDESTROY => {
                let receiver = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Receiver;
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                if !receiver.is_null() {
                    drop(Box::from_raw(receiver));
                }
                DefWindowProcW(hwnd, message, wparam, lparam)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    unsafe fn create_receiver(class: PCWSTR, receive: Receiver) -> windows::core::Result<HWND> {
        let instance = HINSTANCE(GetModuleHandleW(None)?.0);
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(receiver_proc),
            hInstance: instance,
            lpszClassName: class,
            ..Default::default()
        };
        // RegisterClass is process-local; every independent instance advertises a receiver.
        RegisterClassW(&window_class);
        let receiver = Box::into_raw(Box::new(receive));
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            None,
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            instance,
            Some(receiver.cast()),
        )
    }

    fn send_invitation(hwnd: HWND, url: &str) -> bool {
        if invitation(url.as_bytes()).is_none() {
            return false;
        }
        let data = COPYDATASTRUCT {
            dwData: MESSAGE_TAG,
            cbData: url.len() as u32,
            lpData: url.as_ptr().cast_mut().cast(),
        };
        let mut accepted = 0;
        unsafe {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != 0 {
                let _ = AllowSetForegroundWindow(pid);
            }
            SendMessageTimeoutW(
                hwnd,
                WM_COPYDATA,
                WPARAM(0),
                LPARAM(&data as *const _ as isize),
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                500,
                Some(&mut accepted),
            )
            .0 != 0
                && accepted == 1
        }
    }

    pub fn forward_startup_invitation() -> bool {
        let args: Vec<_> = std::env::args_os().collect();
        if args.len() != 2 {
            return false;
        }
        let Some(url) = args[1].to_str().and_then(|raw| invitation(raw.as_bytes())) else {
            return false;
        };
        forward_invitation(CLASS, url)
    }

    fn forward_invitation(class: PCWSTR, url: &str) -> bool {
        let mut previous = HWND::default();
        // Any live instance can receive a link, including after the first one closes.
        for _ in 0..32 {
            let Ok(hwnd) = (unsafe { FindWindowExW(None, previous, class, None) }) else {
                break;
            };
            if send_invitation(hwnd, url) {
                return true;
            }
            previous = hwnd;
        }
        false
    }

    pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
        let app = app.clone();
        unsafe {
            create_receiver(
                CLASS,
                Box::new(move |url| {
                    app.deep_link()
                        .handle_cli_arguments(["p2sharer", url.as_str()].into_iter());
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }),
            )
        }
        .map(|_| ())
        .map_err(|error| error.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn hidden_receiver_forwards_an_invitation_without_launching_the_application() {
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let (url_tx, url_rx) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || unsafe {
                let hwnd = create_receiver(
                    w!("P2Sharer.InvitationRouter.Test"),
                    Box::new(move |url| {
                        url_tx.send(url).unwrap();
                    }),
                )
                .unwrap();
                ready_tx.send(hwnd.0 as usize).unwrap();
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {
                    if message.message == WM_CLOSE {
                        break;
                    }
                    DispatchMessageW(&message);
                }
                DestroyWindow(hwnd).unwrap();
            });
            let hwnd = HWND(ready_rx.recv().unwrap() as *mut std::ffi::c_void);
            let accepted = send_invitation(hwnd, "p2sharer://invite/fixture-credential");
            let rejected = send_invitation(hwnd, "https://example.com");
            let received = url_rx.recv_timeout(std::time::Duration::from_secs(2));
            unsafe {
                PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)).unwrap();
            }
            worker.join().unwrap();
            assert!(accepted);
            assert!(!rejected);
            assert_eq!(received.unwrap(), "p2sharer://invite/fixture-credential");
        }

        #[test]
        fn invitations_find_a_remaining_instance_after_the_first_closes() {
            let class: Vec<u16> = format!("P2Sharer.InvitationRouter.Test.{}", std::process::id())
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let (url_tx, url_rx) = std::sync::mpsc::channel();
            let mut workers = vec![];
            for id in 0..2 {
                let class = class.clone();
                let url_tx = url_tx.clone();
                let (ready_tx, ready_rx) = std::sync::mpsc::channel();
                let worker = std::thread::spawn(move || unsafe {
                    let hwnd = create_receiver(
                        PCWSTR(class.as_ptr()),
                        Box::new(move |url| {
                            url_tx.send((id, url)).unwrap();
                        }),
                    )
                    .unwrap();
                    ready_tx.send(hwnd.0 as usize).unwrap();
                    let mut message = MSG::default();
                    while GetMessageW(&mut message, None, 0, 0).as_bool() {
                        if message.message == WM_CLOSE {
                            break;
                        }
                        DispatchMessageW(&message);
                    }
                    DestroyWindow(hwnd).unwrap();
                });
                workers.push((ready_rx.recv().unwrap(), worker));
            }
            let (first, worker) = workers.remove(0);
            unsafe {
                PostMessageW(HWND(first as *mut _), WM_CLOSE, WPARAM(0), LPARAM(0)).unwrap();
            }
            worker.join().unwrap();
            let accepted = forward_invitation(
                PCWSTR(class.as_ptr()),
                "p2sharer://invite/fixture-credential",
            );
            let received = url_rx.recv_timeout(std::time::Duration::from_secs(2));
            for (hwnd, worker) in workers {
                unsafe {
                    PostMessageW(HWND(hwnd as *mut _), WM_CLOSE, WPARAM(0), LPARAM(0)).unwrap();
                }
                worker.join().unwrap();
            }
            assert!(accepted);
            assert_eq!(received.unwrap().0, 1);
            assert!(!forward_invitation(
                PCWSTR(class.as_ptr()),
                "p2sharer://invite/fixture-credential"
            ));
        }
    }
}

pub fn forward_startup_invitation() -> bool {
    #[cfg(windows)]
    {
        return desktop::forward_startup_invitation();
    }
    #[cfg(not(windows))]
    {
        false
    }
}
pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        return desktop::install(app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routing_accepts_only_bounded_invitation_protocol_payloads() {
        assert!(invitation(b"p2sharer://invite/fixture-credential").is_some());
        assert!(invitation(b"p2sharer://convite/fixture-credential").is_some());
        assert!(invitation(b"p2sharer://invite/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").is_some());
        for value in [
            "",
            "https://example.com",
            "p2sharer://invite/",
            "p2sharer://other/value",
            "p2sharer://invite/value?extra=yes",
        ] {
            assert!(invitation(value.as_bytes()).is_none());
        }
        assert!(invitation(&[0xff]).is_none());
        assert!(invitation(&vec![b'x'; MAX_INVITATION_BYTES + 1]).is_none());
    }
}
