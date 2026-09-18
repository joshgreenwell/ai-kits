//! Attach to the parent console when this binary is linked as a Windows GUI
//! subsystem process. Task Scheduler then starts a run with no window, while
//! `observatory status` still prints in a terminal. Statusline and tests spawn
//! this binary with redirected stdout; those handles are left alone.

#![allow(unsafe_code)]

const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
/// `(DWORD)-11`.
const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5;
const INVALID_HANDLE_VALUE: isize = -1;
const FILE_TYPE_DISK: u32 = 1;
const FILE_TYPE_CHAR: u32 = 2;
const FILE_TYPE_PIPE: u32 = 3;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn AttachConsole(dw_process_id: u32) -> i32;
    fn GetStdHandle(n_std_handle: u32) -> *mut core::ffi::c_void;
    fn GetFileType(h_file: *mut core::ffi::c_void) -> u32;
}

/// Attach to the parent console when stdout is not already a pipe, file, or
/// console. Failure is the silent scheduled-run path.
pub fn attach_parent() {
    // SAFETY: called once at process start, before clap or tracing. Invalid
    // standard handles are rejected before GetFileType. AttachConsole is a
    // no-op when there is no parent console.
    unsafe {
        let stdout = GetStdHandle(STD_OUTPUT_HANDLE);
        if !stdout.is_null() && stdout as isize != INVALID_HANDLE_VALUE {
            match GetFileType(stdout) {
                FILE_TYPE_DISK | FILE_TYPE_CHAR | FILE_TYPE_PIPE => return,
                _ => {}
            }
        }
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}
