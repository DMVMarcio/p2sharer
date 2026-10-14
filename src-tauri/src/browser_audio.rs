//! Host-only speaker gain. Process loopback capture stays upstream of the mixer.
use std::{collections::HashMap, sync::mpsc, thread, time::Duration};
use windows::{
    core::Interface,
    Win32::{Media::Audio::*, System::Com::*},
};

#[derive(Clone, Copy)]
struct Settings {
    volume: f32,
    muted: bool,
}
pub struct LocalAudio {
    sender: Option<mpsc::Sender<Settings>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl LocalAudio {
    pub fn start(root: u32) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let (ready, started) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || unsafe {
            if let Err(error) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
                let _ = ready.send(Err(error.to_string()));
                return;
            }
            {
                let enumerator = CoCreateInstance::<_, IMMDeviceEnumerator>(
                    &MMDeviceEnumerator,
                    None,
                    CLSCTX_ALL,
                );
                match enumerator {
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                    }
                    Ok(enumerator) => {
                        let _ = ready.send(Ok(()));
                        let mut settings = Settings {
                            volume: 1.0,
                            muted: false,
                        };
                        let mut sessions = HashMap::<String, SpeakerSession>::new();
                        let mut processes = sysinfo::System::new();
                        loop {
                            // Discovery is separate from the event-driven WASAPI capture loop.
                            // Wake immediately for controls and discover later audio/device sessions.
                            match receiver.recv_timeout(Duration::from_millis(500)) {
                                Ok(latest) => {
                                    settings = latest;
                                    while let Ok(latest) = receiver.try_recv() {
                                        settings = latest;
                                    }
                                }
                                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                                Err(mpsc::RecvTimeoutError::Timeout) => {}
                            }
                            processes.refresh_processes_specifics(
                                sysinfo::ProcessesToUpdate::All,
                                true,
                                sysinfo::ProcessRefreshKind::new(),
                            );
                            discover(&enumerator, root, &processes, &mut sessions);
                            sessions.retain(|_, session| session.apply(settings).is_ok());
                        }
                        // Release our gain before closing WebViews; never persist a lowered mixer.
                        drop(sessions);
                    }
                }
            }
            CoUninitialize();
        });
        started.recv().map_err(|e| e.to_string())??;
        Ok(Self {
            sender: Some(sender),
            worker: Some(worker),
        })
    }
    pub fn set(&self, volume: f32, muted: bool) -> Result<(), String> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err("Invalid browser volume".into());
        }
        self.sender
            .as_ref()
            .ok_or("Browser audio closed")?
            .send(Settings { volume, muted })
            .map_err(|e| e.to_string())
    }
}
impl Drop for LocalAudio {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct SpeakerSession {
    control: ISimpleAudioVolume,
    original: Settings,
    applied: Option<(f32, bool)>,
}
impl SpeakerSession {
    unsafe fn apply(&mut self, settings: Settings) -> windows::core::Result<()> {
        let value = (
            self.original.volume * settings.volume,
            self.original.muted || settings.muted,
        );
        if self.applied != Some(value) {
            self.control.SetMasterVolume(value.0, std::ptr::null())?;
            self.control.SetMute(value.1, std::ptr::null())?;
            self.applied = Some(value);
        }
        Ok(())
    }
}
impl Drop for SpeakerSession {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .control
                .SetMasterVolume(self.original.volume, std::ptr::null());
            let _ = self.control.SetMute(self.original.muted, std::ptr::null());
        }
    }
}

fn belongs_to_browser(pid: u32, root: u32, parent: impl Fn(u32) -> Option<u32>) -> bool {
    let mut current = pid;
    for _ in 0..64 {
        if current == root {
            return root > 4;
        }
        match parent(current) {
            Some(next) if next > 4 && next != current => current = next,
            _ => return false,
        }
    }
    false
}

unsafe fn discover(
    enumerator: &IMMDeviceEnumerator,
    root: u32,
    processes: &sysinfo::System,
    known: &mut HashMap<String, SpeakerSession>,
) {
    let Ok(devices) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else {
        return;
    };
    for device_index in 0..devices.GetCount().unwrap_or(0) {
        let Ok(device) = devices.Item(device_index) else {
            continue;
        };
        let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
            continue;
        };
        let Ok(sessions) = manager.GetSessionEnumerator() else {
            continue;
        };
        for index in 0..sessions.GetCount().unwrap_or(0) {
            let Ok(session) = sessions.GetSession(index) else {
                continue;
            };
            let Ok(control) = session.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(pid) = control.GetProcessId() else {
                continue;
            };
            if !belongs_to_browser(pid, root, |pid| {
                processes
                    .process(sysinfo::Pid::from_u32(pid))
                    .and_then(|p| p.parent())
                    .map(|p| p.as_u32())
            }) {
                continue;
            }
            let Ok(identifier) = control.GetSessionInstanceIdentifier() else {
                continue;
            };
            let key = identifier.to_string();
            CoTaskMemFree(Some(identifier.0.cast()));
            let Ok(key) = key else { continue };
            if known.contains_key(&key) {
                continue;
            }
            let Ok(volume) = session.cast::<ISimpleAudioVolume>() else {
                continue;
            };
            if let (Ok(level), Ok(muted)) = (volume.GetMasterVolume(), volume.GetMute()) {
                known.insert(
                    key,
                    SpeakerSession {
                        control: volume,
                        original: Settings {
                            volume: level,
                            muted: muted.as_bool(),
                        },
                        applied: None,
                    },
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use windows::Win32::Foundation::BOOL;

    #[windows::core::implement(ISimpleAudioVolume)]
    struct TestMixer(Arc<Mutex<(f32, bool)>>);
    impl ISimpleAudioVolume_Impl for TestMixer_Impl {
        fn SetMasterVolume(
            &self,
            level: f32,
            _: *const windows::core::GUID,
        ) -> windows::core::Result<()> {
            self.0.lock().unwrap().0 = level;
            Ok(())
        }
        fn GetMasterVolume(&self) -> windows::core::Result<f32> {
            Ok(self.0.lock().unwrap().0)
        }
        fn SetMute(&self, muted: BOOL, _: *const windows::core::GUID) -> windows::core::Result<()> {
            self.0.lock().unwrap().1 = muted.as_bool();
            Ok(())
        }
        fn GetMute(&self) -> windows::core::Result<BOOL> {
            Ok(self.0.lock().unwrap().1.into())
        }
    }
    #[test]
    fn local_gain_mutes_and_restores_the_original_speaker_session() {
        let state = Arc::new(Mutex::new((0.8, false)));
        let control: ISimpleAudioVolume = TestMixer(state.clone()).into();
        let mut session = SpeakerSession {
            control,
            original: Settings {
                volume: 0.8,
                muted: false,
            },
            applied: None,
        };
        unsafe {
            session
                .apply(Settings {
                    volume: 0.25,
                    muted: false,
                })
                .unwrap();
            assert_eq!(*state.lock().unwrap(), (0.2, false));
            session
                .apply(Settings {
                    volume: 0.25,
                    muted: true,
                })
                .unwrap();
            assert_eq!(*state.lock().unwrap(), (0.2, true));
            session
                .apply(Settings {
                    volume: 0.0,
                    muted: false,
                })
                .unwrap();
            assert_eq!(*state.lock().unwrap(), (0.0, false));
        }
        drop(session);
        assert_eq!(*state.lock().unwrap(), (0.8, false));
    }
    #[test]
    fn invalid_gain_does_not_reach_the_speaker_worker() {
        let (sender, receiver) = mpsc::channel();
        let audio = LocalAudio {
            sender: Some(sender),
            worker: None,
        };
        for volume in [-1.0, 2.0, f32::NAN, f32::INFINITY] {
            assert!(audio.set(volume, false).is_err());
        }
        assert!(receiver.try_recv().is_err());
        audio.set(0.3, true).unwrap();
        let settings = receiver.recv().unwrap();
        assert_eq!(settings.volume, 0.3);
        assert!(settings.muted);
    }
    #[test]
    fn speaker_control_is_confined_to_the_browser_process_tree() {
        let parents = HashMap::from([
            (10, 5),
            (11, 10),
            (12, 11),
            (20, 5),
            (21, 20),
            (30, 30),
            (40, 41),
            (41, 40),
        ]);
        for pid in [10, 11, 12] {
            assert!(belongs_to_browser(pid, 10, |pid| parents
                .get(&pid)
                .copied()));
        }
        // Main shell, other instances, stale PIDs, system audio and cycles are excluded.
        for pid in [0, 4, 5, 20, 21, 30, 40, 99] {
            assert!(!belongs_to_browser(pid, 10, |pid| parents
                .get(&pid)
                .copied()));
        }
    }
}
