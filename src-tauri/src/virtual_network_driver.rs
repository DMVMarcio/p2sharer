//! Privileged Windows operations. Only the authenticated helper enters this module.
use super::virtual_network_policy::{virtual_ip, Grant, MTU};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    net::Ipv4Addr,
    os::windows::fs::OpenOptionsExt,
    sync::Mutex,
};
use windows::{
    core::{w, BSTR, GUID, PCSTR, PCWSTR},
    Win32::{
        Foundation::{
            CloseHandle, FreeLibrary, GetLastError, BOOLEAN, HANDLE, HMODULE, WAIT_OBJECT_0,
        },
        NetworkManagement::{IpHelper::*, Ndis::NET_LUID_LH, WindowsFirewall::*},
        Networking::WinSock::*,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32},
            Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
        },
        UI::{
            Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
            WindowsAndMessaging::SW_HIDE,
        },
    },
};

const DLL: &[u8] = include_bytes!("../resources/wintun/wintun.dll");
type Create = unsafe extern "system" fn(*const u16, *const u16, *const GUID) -> usize;
type Open = unsafe extern "system" fn(*const u16) -> usize;
type Close = unsafe extern "system" fn(usize);
type Luid = unsafe extern "system" fn(usize, *mut NET_LUID_LH);
type Start = unsafe extern "system" fn(usize, u32) -> usize;
type Wait = unsafe extern "system" fn(usize) -> HANDLE;
type Receive = unsafe extern "system" fn(usize, *mut u32) -> *const u8;
type Release = unsafe extern "system" fn(usize, *const u8);
type Allocate = unsafe extern "system" fn(usize, u32) -> *mut u8;
type Send = unsafe extern "system" fn(usize, *const u8);

struct Api {
    module: usize,
    _file: File,
    create: Create,
    open: Open,
    close: Close,
    luid: Luid,
    start: Start,
    end: Close,
    wait: Wait,
    receive: Receive,
    release: Release,
    allocate: Allocate,
    send: Send,
}
impl Drop for Api {
    fn drop(&mut self) {
        unsafe {
            let _ = FreeLibrary(HMODULE(self.module as _));
        }
    }
}
impl Api {
    fn load() -> Result<Self, String> {
        let dir = dirs::cache_dir()
            .ok_or("Runtime cache unavailable")?
            .join("P2Sharer")
            .join("wintun-0.14.1-amd64");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("wintun.dll");
        if !path.exists() {
            use std::io::Write;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .share_mode(0)
                .open(&path)
                .map_err(|e| e.to_string())?;
            file.write_all(DLL).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() != DLL.len() as u64 {
            return Err("Wintun runtime was modified".into());
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes != DLL {
            return Err("Wintun runtime was modified".into());
        }
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            let module = LoadLibraryExW(PCWSTR(wide.as_ptr()), None, LOAD_LIBRARY_SEARCH_SYSTEM32)
                .map_err(|e| e.to_string())?;
            macro_rules! symbol {
                ($name:literal, $ty:ty) => {
                    match GetProcAddress(module, PCSTR(concat!($name, "\0").as_ptr())) {
                        Some(f) => {
                            std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(f)
                        }
                        None => {
                            let _ = FreeLibrary(module);
                            return Err(concat!("Missing Wintun API: ", $name).into());
                        }
                    }
                };
            }
            Ok(Self {
                module: module.0 as usize,
                _file: file,
                create: symbol!("WintunCreateAdapter", Create),
                open: symbol!("WintunOpenAdapter", Open),
                close: symbol!("WintunCloseAdapter", Close),
                luid: symbol!("WintunGetAdapterLUID", Luid),
                start: symbol!("WintunStartSession", Start),
                end: symbol!("WintunEndSession", Close),
                wait: symbol!("WintunGetReadWaitEvent", Wait),
                receive: symbol!("WintunReceivePacket", Receive),
                release: symbol!("WintunReleaseReceivePacket", Release),
                allocate: symbol!("WintunAllocateSendPacket", Allocate),
                send: symbol!("WintunSendPacket", Send),
            })
        }
    }
}
use std::os::windows::ffi::OsStrExt;
pub struct NetworkLock(HANDLE);
impl NetworkLock {
    pub fn acquire() -> Result<Self, String> {
        unsafe {
            let handle = CreateMutexW(None, false, w!("Global\\P2Sharer.VirtualNetwork"))
                .map_err(|e| e.to_string())?;
            let result = WaitForSingleObject(handle, 0);
            if result != WAIT_OBJECT_0 && result.0 != 0x80 {
                let _ = CloseHandle(handle);
                return Err("Virtual network is in use by another P2Sharer process".into());
            }
            Ok(Self(handle))
        }
    }
}
impl Drop for NetworkLock {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}
pub struct HelperProcess(usize);
impl HelperProcess {
    pub fn exited(&self) -> bool {
        unsafe { WaitForSingleObject(HANDLE(self.0 as _), 0) == WAIT_OBJECT_0 }
    }
    pub fn wait(&self) -> Result<(), String> {
        if unsafe { WaitForSingleObject(HANDLE(self.0 as _), 15_000) } == WAIT_OBJECT_0 {
            Ok(())
        } else {
            Err("Virtual network helper is still shutting down; retry after it finishes".into())
        }
    }
}
impl Drop for HelperProcess {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(HANDLE(self.0 as _));
        }
    }
}
pub fn elevate(port: u16, token: &str) -> Result<HelperProcess, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let parameters: Vec<u16> = format!("--p2sharer-vnet-helper {port} {token}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(path.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        ShellExecuteExW(&mut info).map_err(|e| {
            format!("Virtual network activation requires Windows administrator consent: {e}")
        })?;
    }
    if info.hProcess.is_invalid() {
        return Err("Windows did not return a virtual helper process handle".into());
    }
    Ok(HelperProcess(info.hProcess.0 as usize))
}
fn socket(ip: Ipv4Addr) -> SOCKADDR_INET {
    SOCKADDR_INET {
        Ipv4: SOCKADDR_IN {
            sin_family: AF_INET,
            sin_addr: IN_ADDR {
                S_un: IN_ADDR_0 {
                    S_addr: u32::from_ne_bytes(ip.octets()),
                },
            },
            ..Default::default()
        },
    }
}
fn checked(code: windows::Win32::Foundation::WIN32_ERROR, operation: &str) -> Result<(), String> {
    if code.0 == 0 {
        Ok(())
    } else {
        Err(format!(
            "Virtual network {operation} failed (Windows code {})",
            code.0
        ))
    }
}
pub struct Device {
    api: Api,
    adapter: usize,
    session: usize,
    luid: NET_LUID_LH,
    address: MIB_UNICASTIPADDRESS_ROW,
    address_created: bool,
    routes: Mutex<Vec<MIB_IPFORWARD_ROW2>>,
    ip: Ipv4Addr,
}
impl Device {
    pub fn open(ip: Ipv4Addr) -> Result<Self, String> {
        if !virtual_ip(ip) {
            return Err("Invalid virtual IP".into());
        }
        let api = Api::load()?;
        let guid = GUID::from_u128(0x60f46bd6_aecc_4866_9380_67f676a73a7c);
        unsafe {
            let mut adapter = (api.open)(w!("P2Sharer Virtual Network").as_ptr());
            if adapter == 0 {
                adapter = (api.create)(
                    w!("P2Sharer Virtual Network").as_ptr(),
                    w!("P2Sharer").as_ptr(),
                    &guid,
                );
            }
            if adapter == 0 {
                return Err(format!(
                    "Could not create Wintun adapter (Windows code {})",
                    GetLastError().0
                ));
            }
            let mut luid = NET_LUID_LH::default();
            (api.luid)(adapter, &mut luid);
            let mut address = MIB_UNICASTIPADDRESS_ROW::default();
            InitializeUnicastIpAddressEntry(&mut address);
            address.InterfaceLuid = luid;
            address.Address = socket(ip);
            address.OnLinkPrefixLength = 32;
            address.DadState = IpDadStatePreferred;
            address.PrefixOrigin = IpPrefixOriginManual;
            address.SuffixOrigin = IpSuffixOriginManual;
            let mut device = Self {
                api,
                adapter,
                session: 0,
                luid,
                address,
                address_created: false,
                routes: Mutex::new(Vec::new()),
                ip,
            };
            device.cleanup_stale()?;
            device.check_conflicts(&[ip])?;
            checked(
                CreateUnicastIpAddressEntry(&device.address),
                "address assignment",
            )?;
            device.address_created = true;
            let mut interface = MIB_IPINTERFACE_ROW {
                Family: AF_INET,
                InterfaceLuid: luid,
                ..Default::default()
            };
            checked(GetIpInterfaceEntry(&mut interface), "interface lookup")?;
            interface.NlMtu = MTU as u32;
            interface.UseAutomaticMetric = BOOLEAN(0);
            interface.Metric = 5;
            interface.ForwardingEnabled = BOOLEAN(0);
            interface.WeakHostReceive = BOOLEAN(0);
            interface.WeakHostSend = BOOLEAN(0);
            interface.DadTransmits = 0;
            interface.DisableDefaultRoutes = BOOLEAN(1);
            checked(
                SetIpInterfaceEntry(&mut interface),
                "interface configuration",
            )?;
            device.session = (device.api.start)(adapter, 0x400000);
            if device.session == 0 {
                return Err(format!(
                    "Could not start Wintun (Windows code {})",
                    GetLastError().0
                ));
            }
            Ok(device)
        }
    }
    fn cleanup_stale(&self) -> Result<(), String> {
        // A crashed helper can leave active-store entries. The singleton guard is held;
        // touch only this application's adapter, virtual addresses and exact peer routes.
        unsafe {
            let mut addresses = std::ptr::null_mut();
            checked(
                GetUnicastIpAddressTable(AF_INET, &mut addresses),
                "stale address lookup",
            )?;
            for row in std::slice::from_raw_parts(
                (*addresses).Table.as_ptr(),
                (*addresses).NumEntries as usize,
            ) {
                let ip = Ipv4Addr::from(row.Address.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes());
                if row.InterfaceLuid.Value == self.luid.Value
                    && row.OnLinkPrefixLength == 32
                    && virtual_ip(ip)
                {
                    let _ = DeleteUnicastIpAddressEntry(row);
                }
            }
            FreeMibTable(addresses as _);
            let mut routes = std::ptr::null_mut();
            checked(
                GetIpForwardTable2(AF_INET, &mut routes),
                "stale route lookup",
            )?;
            for row in
                std::slice::from_raw_parts((*routes).Table.as_ptr(), (*routes).NumEntries as usize)
            {
                let ip = Ipv4Addr::from(
                    row.DestinationPrefix
                        .Prefix
                        .Ipv4
                        .sin_addr
                        .S_un
                        .S_addr
                        .to_ne_bytes(),
                );
                if row.InterfaceLuid.Value == self.luid.Value
                    && row.DestinationPrefix.PrefixLength == 32
                    && virtual_ip(ip)
                {
                    let _ = DeleteIpForwardEntry2(row);
                }
            }
            FreeMibTable(routes as _);
            Ok(())
        }
    }
    fn check_conflicts(&self, peers: &[Ipv4Addr]) -> Result<(), String> {
        if address_conflict(peers, Some(unsafe { self.luid.Value }))? {
            Err("Virtual IP conflicts with a local network; regenerate an address".into())
        } else {
            Ok(())
        }
    }
    pub fn routes(&self, peers: &[Ipv4Addr]) -> Result<(), String> {
        if peers.len() > 128 || peers.iter().any(|p| !virtual_ip(*p) || *p == self.ip) {
            return Err("Invalid virtual routes".into());
        }
        self.check_conflicts(peers)?;
        let mut routes = self.routes.lock().unwrap();
        unsafe {
            let mut index = 0;
            while index < routes.len() {
                let ip = Ipv4Addr::from(
                    routes[index]
                        .DestinationPrefix
                        .Prefix
                        .Ipv4
                        .sin_addr
                        .S_un
                        .S_addr
                        .to_ne_bytes(),
                );
                if peers.contains(&ip) {
                    index += 1;
                } else {
                    checked(DeleteIpForwardEntry2(&routes[index]), "peer route removal")?;
                    routes.remove(index);
                }
            }
            for ip in peers {
                if routes.iter().any(|r| {
                    Ipv4Addr::from(
                        r.DestinationPrefix
                            .Prefix
                            .Ipv4
                            .sin_addr
                            .S_un
                            .S_addr
                            .to_ne_bytes(),
                    ) == *ip
                }) {
                    continue;
                }
                let mut row = MIB_IPFORWARD_ROW2::default();
                InitializeIpForwardEntry(&mut row);
                row.InterfaceLuid = self.luid;
                row.DestinationPrefix.Prefix = socket(*ip);
                row.DestinationPrefix.PrefixLength = 32;
                row.NextHop = socket(Ipv4Addr::UNSPECIFIED);
                row.Metric = 5;
                row.Protocol = MIB_IPPROTO_NETMGMT;
                checked(CreateIpForwardEntry2(&row), "peer route")?;
                routes.push(row);
            }
        }
        Ok(())
    }
    pub fn receive(&self) -> Result<Option<Vec<u8>>, String> {
        unsafe {
            let mut n = 0;
            let packet = (self.api.receive)(self.session, &mut n);
            if !packet.is_null() {
                let bytes = if n as usize <= MTU {
                    Some(std::slice::from_raw_parts(packet, n as usize).to_vec())
                } else {
                    None
                };
                (self.api.release)(self.session, packet);
                return Ok(bytes);
            }
            if GetLastError().0 != 259 {
                return Err("Wintun packet reader stopped".into());
            }
            WaitForSingleObject((self.api.wait)(self.session), 100);
            Ok(None)
        }
    }
    pub fn send(&self, data: &[u8]) -> Result<(), String> {
        if data.is_empty() || data.len() > MTU {
            return Err("Invalid virtual packet length".into());
        }
        unsafe {
            let packet = (self.api.allocate)(self.session, data.len() as u32);
            if packet.is_null() {
                if GetLastError().0 == 111 {
                    return Ok(());
                }
                return Err("Wintun packet writer stopped".into());
            }
            std::ptr::copy_nonoverlapping(data.as_ptr(), packet, data.len());
            (self.api.send)(self.session, packet);
        }
        Ok(())
    }
}
pub fn address_conflict(peers: &[Ipv4Addr], exclude: Option<u64>) -> Result<bool, String> {
    unsafe {
        let mut table = std::ptr::null_mut();
        checked(
            GetUnicastIpAddressTable(AF_INET, &mut table),
            "address lookup",
        )?;
        let rows =
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        let conflict = rows.iter().any(|row| {
            if exclude == Some(row.InterfaceLuid.Value) {
                return false;
            }
            let bytes = row.Address.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes();
            let mask = u32::MAX
                .checked_shl(32u32.saturating_sub(row.OnLinkPrefixLength as u32))
                .unwrap_or(0);
            let address = u32::from_be_bytes(bytes);
            peers
                .iter()
                .any(|p| u32::from_be_bytes(p.octets()) & mask == address & mask)
        });
        FreeMibTable(table as _);
        Ok(conflict)
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        unsafe {
            for route in self.routes.lock().unwrap().drain(..) {
                let _ = DeleteIpForwardEntry2(&route);
            }
            if self.address_created {
                let _ = DeleteUnicastIpAddressEntry(&self.address);
            }
            if self.session != 0 {
                (self.api.end)(self.session);
            }
            (self.api.close)(self.adapter);
        }
    }
}
pub struct Firewall {
    rules: INetFwRules,
}
impl Firewall {
    pub fn new() -> Result<Self, String> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| e.to_string())?;
            let policy: INetFwPolicy2 = CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
            Ok(Self {
                rules: policy.Rules().map_err(|e| e.to_string())?,
            })
        }
    }
    fn remove(&self) {
        unsafe {
            for protocol in [6, 17, 1] {
                let _ = self
                    .rules
                    .Remove(&BSTR::from(format!("P2Sharer Virtual Network {protocol}")));
            }
        }
    }
    pub fn configure(
        &self,
        ip: Ipv4Addr,
        peers: &[Ipv4Addr],
        grants: &[Grant],
    ) -> Result<(), String> {
        self.remove();
        if peers.is_empty() || grants.is_empty() {
            return Ok(());
        }
        let result = (|| -> windows::core::Result<()> {
            unsafe {
                for protocol in [6, 17, 1] {
                    let any = grants.iter().any(|g| g.protocol == "any");
                    let mut ports: Vec<_> = grants
                        .iter()
                        .filter(|g| {
                            (protocol == 6 && g.protocol == "tcp")
                                || (protocol == 17 && g.protocol == "udp")
                        })
                        .map(|g| g.port.to_string())
                        .collect();
                    ports.sort();
                    ports.dedup();
                    if !any && ports.is_empty() {
                        continue;
                    }
                    let rule: INetFwRule =
                        CoCreateInstance(&NetFwRule, None, CLSCTX_INPROC_SERVER)?;
                    rule.SetName(&BSTR::from(format!("P2Sharer Virtual Network {protocol}")))?;
                    rule.SetProtocol(protocol)?;
                    if protocol != 1 {
                        rule.SetLocalPorts(&BSTR::from(if any {
                            "*".into()
                        } else {
                            ports.join(",")
                        }))?;
                    } else {
                        rule.SetIcmpTypesAndCodes(&BSTR::from("0:*,8:*"))?;
                    }
                    rule.SetLocalAddresses(&BSTR::from(ip.to_string()))?;
                    rule.SetRemoteAddresses(&BSTR::from(
                        peers
                            .iter()
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                            .join(","),
                    ))?;
                    rule.SetDirection(NET_FW_RULE_DIR_IN)?;
                    rule.SetAction(NET_FW_ACTION_ALLOW)?;
                    rule.SetProfiles(NET_FW_PROFILE2_ALL.0)?;
                    rule.SetEnabled(windows::Win32::Foundation::VARIANT_TRUE)?;
                    self.rules.Add(&rule)?;
                }
                Ok(())
            }
        })();
        if result.is_err() {
            self.remove();
        }
        result.map_err(|e| format!("Virtual network firewall configuration failed: {e}"))
    }
}
impl Drop for Firewall {
    fn drop(&mut self) {
        self.remove();
        unsafe {
            CoUninitialize();
        }
    }
}
