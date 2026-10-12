// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if p2sharer_lib::virtual_network::run_helper_if_requested() { return; }
    p2sharer_lib::run()
}

