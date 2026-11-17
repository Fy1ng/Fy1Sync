//! One-shot browser key broker. It never accesses browser files or cookie databases.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use zeroize::{Zeroize, Zeroizing};

const MAX_MESSAGE: usize = 32 * 1024;
type Result<T> = std::result::Result<T, &'static str>;
const INVALID: &str = "browser-import-invalid-request";
const DECRYPT: &str = "browser-import-decryption-failed";
const TIMEOUT: &str = "browser-import-timeout";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    browser: String,
    app_bound_key: Option<String>,
    legacy_key: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cng_unwrapped_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    legacy_key: Option<String>,
}
impl Drop for Response {
    fn drop(&mut self) {
        if let Some(value) = &mut self.content { value.zeroize(); }
        if let Some(value) = &mut self.cng_unwrapped_key { value.zeroize(); }
        if let Some(value) = &mut self.legacy_key { value.zeroize(); }
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        if let Some(value) = &mut self.app_bound_key { value.zeroize(); }
        if let Some(value) = &mut self.legacy_key { value.zeroize(); }
    }
}

fn decode(value: &str, limit: usize) -> Result<Zeroizing<Vec<u8>>> {
    if value.len() > limit * 2 { return Err(INVALID); }
    let bytes = Zeroizing::new(STANDARD.decode(value).map_err(|_| INVALID)?);
    if bytes.is_empty() || bytes.len() > limit || STANDARD.encode(&*bytes) != value { return Err(INVALID); }
    Ok(bytes)
}

fn request(text: &[u8]) -> Result<Request> {
    if text.is_empty() || text.len() > MAX_MESSAGE { return Err(INVALID); }
    let value: Request = serde_json::from_slice(text).map_err(|_| INVALID)?;
    if !matches!(value.browser.as_str(), "chrome" | "edge")
        || value.app_bound_key.is_none() && value.legacy_key.is_none() { return Err(INVALID); }
    Ok(value)
}

fn framing(blob: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    fn size(blob: &[u8], offset: usize) -> Result<usize> {
        let bytes = blob.get(offset..offset + 4).ok_or(DECRYPT)?;
        Ok(u32::from_le_bytes(bytes.try_into().map_err(|_| DECRYPT)?) as usize)
    }
    let header = size(blob, 0)?;
    if header > 4096 { return Err(DECRYPT); }
    let length = size(blob, header + 4)?;
    let start = header + 8;
    if start + length != blob.len() { return Err(DECRYPT); }
    let content = blob.get(start..).ok_or(DECRYPT)?;
    match (length, content.first()) {
        (32, _) | (61, Some(1 | 2)) | (93, Some(3 | 4)) => Ok(Zeroizing::new(content.to_vec())),
        _ => Err(DECRYPT),
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{mem::{size_of, zeroed}, ptr::{null, null_mut}, thread, time::{Duration, Instant}};
    use windows_sys::Win32::{
        Foundation::*, Security::{*, Authorization::*, Cryptography::*},
        Storage::FileSystem::*, System::{Diagnostics::ToolHelp::*, Pipes::*, Threading::*},
        UI::{Shell::*, WindowsAndMessaging::SW_HIDE},
    };

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
    fn checked(ok: i32) -> Result<()> { if ok == 0 { Err(DECRYPT) } else { Ok(()) } }
    struct Handle(HANDLE);
    impl Drop for Handle { fn drop(&mut self) { unsafe { if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE { CloseHandle(self.0); } } } }

    fn token(process: HANDLE, access: u32) -> Result<Handle> {
        let mut value = null_mut();
        unsafe { checked(OpenProcessToken(process, access, &mut value))?; }
        Ok(Handle(value))
    }
    fn token_info(handle: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
        let mut bytes = 0;
        unsafe { GetTokenInformation(handle, class, null_mut(), 0, &mut bytes); }
        if bytes == 0 || bytes > 16384 { return Err(DECRYPT); }
        let mut buffer = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
        unsafe { checked(GetTokenInformation(handle, class, buffer.as_mut_ptr().cast(), bytes, &mut bytes))?; }
        Ok(buffer)
    }
    pub fn elevated() -> Result<bool> {
        let own = token(unsafe { GetCurrentProcess() }, TOKEN_QUERY)?;
        let buffer = token_info(own.0, TokenElevation)?;
        Ok(unsafe { (*(buffer.as_ptr() as *const TOKEN_ELEVATION)).TokenIsElevated != 0 })
    }
    fn enable_debug() -> Result<()> {
        let own = token(unsafe { GetCurrentProcess() }, TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES)?;
        let name = wide("SeDebugPrivilege");
        let mut privileges: TOKEN_PRIVILEGES = unsafe { zeroed() };
        privileges.PrivilegeCount = 1;
        unsafe {
            checked(LookupPrivilegeValueW(null(), name.as_ptr(), &mut privileges.Privileges[0].Luid))?;
            privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
            SetLastError(0);
            checked(AdjustTokenPrivileges(own.0, 0, &privileges, 0, null_mut(), null_mut()))?;
            if GetLastError() != 0 { return Err(DECRYPT); }
        }
        Ok(())
    }
    struct Impersonation { _token: Handle }
    impl Drop for Impersonation { fn drop(&mut self) { unsafe { if RevertToSelf() == 0 { std::process::exit(1); } } } }
    fn system() -> Result<Impersonation> {
        enable_debug()?;
        let snapshot = Handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) });
        if snapshot.0 == INVALID_HANDLE_VALUE { return Err(DECRYPT); }
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut present = unsafe { Process32FirstW(snapshot.0, &mut entry) };
        while present != 0 {
            let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase();
            if name == "services.exe" || name == "winlogon.exe" {
                let process = Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID) });
                if !process.0.is_null() {
                    if let Ok(source) = token(process.0, TOKEN_QUERY | TOKEN_DUPLICATE) {
                        if let Ok(buffer) = token_info(source.0, TokenUser) {
                            let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
                            if unsafe { IsWellKnownSid(user.User.Sid, WinLocalSystemSid) } != 0 {
                                let mut duplicate = null_mut();
                                if unsafe { DuplicateToken(source.0, SecurityImpersonation, &mut duplicate) } != 0 {
                                    let handle = Handle(duplicate);
                                    unsafe { checked(ImpersonateLoggedOnUser(handle.0))?; }
                                    return Ok(Impersonation { _token: handle });
                                }
                            }
                        }
                    }
                }
            }
            present = unsafe { Process32NextW(snapshot.0, &mut entry) };
        }
        Err(DECRYPT)
    }
    pub fn unprotect(bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
        let mut output: CRYPT_INTEGER_BLOB = unsafe { zeroed() };
        unsafe {
            checked(CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output))?;
            let result = if output.cbData > 16384 || output.pbData.is_null() { Err(DECRYPT) }
                else { Ok(Zeroizing::new(std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec())) };
            if !output.pbData.is_null() {
                std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize).zeroize();
                LocalFree(output.pbData.cast());
            }
            result
        }
    }
    fn system_dpapi(blob: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        if blob.len() < 20 || blob.len() > 8192 || !blob.starts_with(b"APPB") { return Err(INVALID); }
        let _identity = system()?;
        unprotect(&blob[4..])
    }
    fn cng(blob: &[u8], version: u8) -> Result<Zeroizing<Vec<u8>>> {
        if blob.len() != 32 || !matches!(version, 3 | 4) { return Err(INVALID); }
        let _identity = system()?;
        let provider_name = wide("Microsoft Software Key Storage Provider");
        let key_name = wide(if version == 4 { "Google Chromekey2" } else { "Google Chromekey1" });
        let mut provider = 0;
        let mut key = 0;
        let operation = (|| unsafe {
            if NCryptOpenStorageProvider(&mut provider, provider_name.as_ptr(), 0) != 0 { return Err(DECRYPT); }
            if NCryptOpenKey(provider, &mut key, key_name.as_ptr(), 0, NCRYPT_SILENT_FLAG) != 0 { return Err(DECRYPT); }
            let mut output = Zeroizing::new(vec![0u8; 256]);
            let mut written = 0;
            if NCryptDecrypt(key, blob.as_ptr(), blob.len() as u32, null(), output.as_mut_ptr(), output.len() as u32,
                &mut written, NCRYPT_SILENT_FLAG) != 0 || written != 32 { return Err(DECRYPT); }
            output.truncate(32);
            Ok(output)
        })();
        unsafe { if key != 0 { NCryptFreeObject(key); } if provider != 0 { NCryptFreeObject(provider); } }
        operation
    }

    #[derive(Serialize, Deserialize)]
    #[serde(tag = "operation", deny_unknown_fields)]
    enum PipeRequest { System { blob: String }, Cng { version: u8, blob: String }, Finish }
    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PipeResponse { value: Option<String>, error_code: Option<String> }
    impl Drop for PipeResponse { fn drop(&mut self) { if let Some(value) = &mut self.value { value.zeroize(); } } }

    fn write_message<T: Serialize>(handle: HANDLE, message: &T) -> Result<()> {
        let bytes = Zeroizing::new(serde_json::to_vec(message).map_err(|_| INVALID)?);
        if bytes.len() > MAX_MESSAGE { return Err(INVALID); }
        let mut written = 0;
        unsafe { checked(WriteFile(handle, bytes.as_ptr(), bytes.len() as u32, &mut written, null_mut()))?; }
        if written as usize != bytes.len() { return Err(DECRYPT); }
        Ok(())
    }
    fn read_message<T: for<'de> Deserialize<'de>>(handle: HANDLE) -> Result<T> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut buffer = Zeroizing::new(vec![0u8; MAX_MESSAGE]);
        loop {
            let mut read = 0;
            let ok = unsafe { ReadFile(handle, buffer.as_mut_ptr(), buffer.len() as u32, &mut read, null_mut()) };
            if ok != 0 {
                if read == 0 { return Err(DECRYPT); }
                return serde_json::from_slice(&buffer[..read as usize]).map_err(|_| INVALID);
            }
            if unsafe { GetLastError() } != ERROR_NO_DATA { return Err(DECRYPT); }
            if Instant::now() >= deadline { return Err(TIMEOUT); }
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn user_sid() -> Result<String> {
        let own = token(unsafe { GetCurrentProcess() }, TOKEN_QUERY)?;
        let buffer = token_info(own.0, TokenUser)?;
        let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
        let mut text = null_mut();
        unsafe { checked(ConvertSidToStringSidW(user.User.Sid, &mut text))?; }
        let mut length = 0;
        unsafe { while *text.add(length) != 0 { length += 1; } }
        let result = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(text, length)) };
        unsafe { LocalFree(text.cast()); }
        Ok(result)
    }
    fn same_executable(process: HANDLE) -> Result<bool> {
        let mut length = 32768u32;
        let mut buffer = vec![0u16; length as usize];
        unsafe { checked(QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length))?; }
        let image = std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize]));
        let own = std::env::current_exe().map_err(|_| DECRYPT)?;
        let image = std::fs::canonicalize(image).map_err(|_| DECRYPT)?;
        let own = std::fs::canonicalize(own).map_err(|_| DECRYPT)?;
        Ok(image.to_string_lossy().to_lowercase() == own.to_string_lossy().to_lowercase())
    }
    struct Elevated { pipe: Handle, process: Handle }
    impl Drop for Elevated {
        fn drop(&mut self) {
            let _ = write_message(self.pipe.0, &PipeRequest::Finish);
            unsafe { if WaitForSingleObject(self.process.0, 1000) != WAIT_OBJECT_0 { TerminateProcess(self.process.0, 1); } }
        }
    }
    impl Elevated {
        fn start() -> Result<Self> {
            let mut random = [0u8; 16];
            if unsafe { BCryptGenRandom(null_mut(), random.as_mut_ptr(), random.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) } != 0 { return Err(DECRYPT); }
            let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
            let name = format!(r"\\.\pipe\Fy1Sync-BrowserKeys-{}-{suffix}", std::process::id());
            let sid = user_sid()?;
            let sddl = wide(&format!("D:P(A;;GA;;;{sid})(A;;GA;;;SY)(A;;GA;;;BA)"));
            let mut descriptor = null_mut();
            unsafe { checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, null_mut()))?; }
            let security = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
            let pipe = Handle(unsafe { CreateNamedPipeW(wide(&name).as_ptr(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, MAX_MESSAGE as u32,
                MAX_MESSAGE as u32, 30000, &security) });
            unsafe { LocalFree(descriptor); }
            if pipe.0 == INVALID_HANDLE_VALUE { return Err(DECRYPT); }
            let executable = std::env::current_exe().map_err(|_| DECRYPT)?;
            let executable = wide(executable.to_str().ok_or(DECRYPT)?);
            let arguments = wide(&format!("--system-pipe {name} --parent {}", std::process::id()));
            let verb = wide("runas");
            let mut launch: SHELLEXECUTEINFOW = unsafe { zeroed() };
            launch.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
            launch.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
            launch.lpVerb = verb.as_ptr(); launch.lpFile = executable.as_ptr(); launch.lpParameters = arguments.as_ptr(); launch.nShow = SW_HIDE;
            if unsafe { ShellExecuteExW(&mut launch) } == 0 {
                return Err(if unsafe { GetLastError() } == ERROR_CANCELLED { "browser-import-uac-cancelled" } else { DECRYPT });
            }
            let process = Handle(launch.hProcess);
            if process.0.is_null() { return Err(DECRYPT); }
            let expected = unsafe { GetProcessId(process.0) };
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                let connected = unsafe { ConnectNamedPipe(pipe.0, null_mut()) } != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
                if connected {
                    let mut actual = 0;
                    if unsafe { GetNamedPipeClientProcessId(pipe.0, &mut actual) } != 0 && actual == expected && same_executable(process.0)? {
                        return Ok(Self { pipe, process });
                    }
                    unsafe { DisconnectNamedPipe(pipe.0); }
                }
                if Instant::now() >= deadline || unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 {
                    unsafe { TerminateProcess(process.0, 1); }
                    return Err(TIMEOUT);
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
        fn rpc(&self, message: PipeRequest) -> Result<Zeroizing<Vec<u8>>> {
            write_message(self.pipe.0, &message)?;
            let response: PipeResponse = read_message(self.pipe.0)?;
            if response.error_code.is_some() { return Err(DECRYPT); }
            decode(response.value.as_deref().ok_or(DECRYPT)?, 16384)
        }
    }

    pub fn broker(value: Request) -> Result<Response> {
        let mut result = Response::default();
        if let Some(key) = value.legacy_key.as_deref() {
            let encrypted = decode(key, 8192)?;
            if !encrypted.starts_with(b"DPAPI") || encrypted.len() < 21 { return Err(INVALID); }
            let clear = unprotect(&encrypted[5..])?;
            if clear.len() != 32 { return Err(DECRYPT); }
            result.legacy_key = Some(STANDARD.encode(&*clear));
        }
        if let Some(key) = value.app_bound_key.as_deref() {
            let encrypted = decode(key, 8192)?;
            if !encrypted.starts_with(b"APPB") || encrypted.len() < 20 { return Err(INVALID); }
            let child = if elevated()? { None } else { Some(Elevated::start()?) };
            let inner = if let Some(child) = &child { child.rpc(PipeRequest::System { blob: STANDARD.encode(&*encrypted) })? }
                else { system_dpapi(&encrypted)? };
            // This layer always runs as the original broker user, after reverting SYSTEM.
            let clear = unprotect(&inner)?;
            let content = framing(&clear)?;
            if content.len() == 93 {
                let version = content[0];
                let intermediate = if let Some(child) = &child {
                    child.rpc(PipeRequest::Cng { version, blob: STANDARD.encode(&content[1..33]) })?
                } else { cng(&content[1..33], version)? };
                if intermediate.len() != 32 { return Err(DECRYPT); }
                result.cng_unwrapped_key = Some(STANDARD.encode(&*intermediate));
            }
            result.content = Some(STANDARD.encode(&*content));
        }
        Ok(result)
    }

    pub fn child(name: &str, parent: u32) -> Result<()> {
        let expected_prefix = format!(r"\\.\pipe\Fy1Sync-BrowserKeys-{parent}-");
        let suffix = name.strip_prefix(&expected_prefix).ok_or(INVALID)?;
        if suffix.len() != 32 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) || parent == 0 || !elevated()? { return Err(INVALID); }
        let deadline = Instant::now() + Duration::from_secs(30);
        let pipe = loop {
            let handle = unsafe { CreateFileW(wide(name).as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, null(), OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, null_mut()) };
            if handle != INVALID_HANDLE_VALUE { break Handle(handle); }
            if Instant::now() >= deadline { return Err(TIMEOUT); }
            thread::sleep(Duration::from_millis(20));
        };
        let mut actual = 0;
        unsafe { checked(GetNamedPipeServerProcessId(pipe.0, &mut actual))?; }
        if actual != parent { return Err(INVALID); }
        let parent_handle = Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, parent) });
        if parent_handle.0.is_null() || !same_executable(parent_handle.0)? { return Err(INVALID); }
        let mode = PIPE_READMODE_MESSAGE | PIPE_NOWAIT;
        unsafe { checked(SetNamedPipeHandleState(pipe.0, &mode, null(), null()))?; }
        let first: PipeRequest = read_message(pipe.0)?;
        let outer = match first {
            PipeRequest::System { mut blob } => { let decoded = decode(&blob, 8192)?; blob.zeroize(); system_dpapi(&decoded) },
            _ => Err(INVALID),
        };
        let response = PipeResponse { value: outer.as_ref().ok().map(|bytes| STANDARD.encode(&**bytes)),
            error_code: outer.as_ref().err().map(|code| code.to_string()) };
        write_message(pipe.0, &response)?;
        outer?;
        match read_message::<PipeRequest>(pipe.0)? {
            PipeRequest::Finish => Ok(()),
            PipeRequest::Cng { version, mut blob } => {
                let decoded = decode(&blob, 32)?; blob.zeroize();
                let result = cng(&decoded, version);
                let response = PipeResponse { value: result.as_ref().ok().map(|bytes| STANDARD.encode(&**bytes)),
                    error_code: result.err().map(|code| code.to_string()) };
                write_message(pipe.0, &response)?;
                if matches!(read_message::<PipeRequest>(pipe.0)?, PipeRequest::Finish) { Ok(()) } else { Err(INVALID) }
            }
            _ => Err(INVALID),
        }
    }

    pub fn self_test() -> Result<()> {
        if !elevated()? { return Err(DECRYPT); }
        fn protect(bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
            let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
            let mut output: CRYPT_INTEGER_BLOB = unsafe { zeroed() };
            unsafe { checked(CryptProtectData(&input, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output))?; }
            let result = Zeroizing::new(unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() });
            unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize).zeroize(); LocalFree(output.pbData.cast()); }
            Ok(result)
        }
        let mut fixture = Zeroizing::new(vec![0u8; 32]);
        if unsafe { BCryptGenRandom(null_mut(), fixture.as_mut_ptr(), 32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) } != 0 { return Err(DECRYPT); }
        let mut frame = Zeroizing::new(Vec::new());
        frame.extend_from_slice(&0u32.to_le_bytes()); frame.extend_from_slice(&32u32.to_le_bytes()); frame.extend_from_slice(&fixture);
        let inner = protect(&frame)?;
        let encrypted = { let _identity = system()?; protect(&inner)? };
        let mut app_bound = Zeroizing::new(b"APPB".to_vec()); app_bound.extend_from_slice(&encrypted);
        // Exercise the actual runas peer and named-pipe transport with synthetic data only.
        let elevated = Elevated::start()?;
        let returned = elevated.rpc(PipeRequest::System { blob: STANDARD.encode(&*app_bound) })?;
        let clear = unprotect(&returned)?;
        let decoded = framing(&clear)?;
        if *decoded != *fixture { return Err(DECRYPT); }
        println!("{{\"status\":\"passed\",\"namedPipeRoundTrip\":true,\"peerProcessAndImageVerified\":true,\"originalUserDpapiRoundTrip\":true,\"browserDataAccessed\":false,\"keyValuesLogged\":false}}");
        Ok(())
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("{{\"protocolVersion\":1,\"version\":\"0.1.0\"}}");
        return Ok(());
    }
    #[cfg(windows)]
    if args == ["--self-test"] { return native::self_test(); }
    #[cfg(windows)]
    if args.len() == 4 && args[0] == "--system-pipe" && args[2] == "--parent" {
        return native::child(&args[1], args[3].parse().map_err(|_| INVALID)?);
    }
    if args != ["--stdin"] { return Err(INVALID); }
    let mut input = Zeroizing::new(Vec::new());
    std::io::stdin().take((MAX_MESSAGE + 1) as u64).read_to_end(&mut input).map_err(|_| INVALID)?;
    let value = request(&input)?;
    #[cfg(windows)]
    let output = native::broker(value)?;
    #[cfg(not(windows))]
    { let _ = value; return Err("browser-import-unsupported"); }
    #[cfg(windows)]
    {
        let bytes = Zeroizing::new(serde_json::to_vec(&output).map_err(|_| DECRYPT)?);
        std::io::stdout().write_all(&bytes).map_err(|_| DECRYPT)?;
        std::io::stdout().flush().map_err(|_| DECRYPT)?;
    }
    Ok(())
}

fn main() {
    // Killing the broker closes its pipe. The elevated child also has a hard lifetime.
    std::thread::spawn(|| { std::thread::sleep(std::time::Duration::from_secs(120)); std::process::exit(1); });
    if let Err(code) = run() {
        if !std::env::args().any(|arg| arg == "--system-pipe") {
            let _ = write!(std::io::stdout(), "{{\"errorCode\":\"{code}\"}}");
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(content: &[u8]) -> Vec<u8> {
        [4u32.to_le_bytes().as_slice(), b"test", (content.len() as u32).to_le_bytes().as_slice(), content].concat()
    }
    #[test]
    fn bounds_and_unknown_request_fields_are_rejected() {
        assert!(request(br#"{"browser":"chrome","appBoundKey":"eA==","path":"secret"}"#).is_err());
        assert!(request(br#"{"browser":"other","appBoundKey":"eA=="}"#).is_err());
        assert!(request(br#"{"browser":"edge"}"#).is_err());
        assert!(request(&vec![b' '; MAX_MESSAGE + 1]).is_err());
        assert!(decode("not base64", 8).is_err());
        assert!(decode(&STANDARD.encode([1u8; 33]), 32).is_err());
    }
    #[test]
    fn exact_versions_and_direct_key_frames_are_supported() {
        assert_eq!(&*framing(&frame(&[0u8; 32])).unwrap(), &[0u8; 32]);
        for (version, length) in [(1,61), (2,61), (3,93), (4,93)] {
            let mut content = vec![0u8; length]; content[0] = version;
            assert_eq!(&*framing(&frame(&content)).unwrap(), &content);
            assert!(framing(&frame(&content[..length-1])).is_err());
        }
    }
    #[test]
    fn unknown_versions_trailing_bytes_and_bad_lengths_are_rejected() {
        assert!(framing(&[]).is_err());
        assert!(framing(&[255u8; 16]).is_err());
        assert!(framing(&frame(&[5u8; 93])).is_err());
        let mut extra = frame(&[0u8; 32]); extra.push(0);
        assert!(framing(&extra).is_err());
    }
}
